/**
 * Library (Browse) — search, inspect, organize (B1: browse = manage).
 * Free-text search with working filter tokens (level:B1 · type:verb ·
 * deck:"…"), state-dot ledger rows, the universal card peek, multi-select
 * with a real bulk action bar (B8), and cause-split empty states (B7).
 * Sort and the filter-sheet chips are wired for real (they held no state
 * in the mock — WIRING.md §3 listed them as stubs to build).
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CardPeek } from '@/components/sheets/CardPeek';
import { CreateSheet } from '@/components/sheets/CreateSheet';
import {
  Btn,
  Chip,
  FAB,
  Ion,
  LevelBadge,
  Overline,
  ScreenHead,
  Sheet,
  StateDot,
} from '@/components/ui';
import { collectionFilter } from '@/domain/queue';
import { formatIntervalDays } from '@/domain/srs';
import { Card, CardState, CefrLevel, displayState } from '@/domain/types';
import { useData } from '@/store/DataContext';
import { useNow } from '@/store/useNow';
import { useSnackbar } from '@/store/SnackbarContext';
import { font, TABBAR_HEIGHT, tnum } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

type ChipScope = 'all' | 'due' | 'new' | 'fav';
type SortMode = 'smart' | 'az' | 'newest' | 'hardest';

const SORT_LABEL: Record<SortMode, string> = {
  smart: 'smart',
  az: 'A–Z',
  newest: 'newest',
  hardest: 'hardest',
};
const SORT_CYCLE: SortMode[] = ['smart', 'az', 'newest', 'hardest'];
const LEVELS: CefrLevel[] = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const STATUS_FILTERS = ['New', 'Learning', 'Due', 'Mastered', 'Suspended', 'Flagged'] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

/** Parse `level:B1 type:verb deck:"Spanish — Travel"` tokens from a query. */
function parseQuery(q: string): {
  text: string;
  level?: string;
  type?: string;
  deck?: string;
} {
  let text = q;
  const grab = (key: string): string | undefined => {
    const re = new RegExp(`${key}:(?:"([^"]+)"|(\\S+))`, 'i');
    const m = text.match(re);
    if (!m) return undefined;
    text = text.replace(m[0], '').trim();
    return (m[1] ?? m[2]).toLowerCase();
  };
  const level = grab('level');
  const type = grab('type');
  const deck = grab('deck');
  return { text: text.trim().toLowerCase(), level, type, deck };
}

const STATE_PRIORITY: Record<CardState, number> = {
  due: 0,
  learning: 1,
  new: 2,
  review: 3,
  mastered: 4,
};

export default function BrowseScreen() {
  const c = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { state, actions } = useData();
  const { show } = useSnackbar();
  const params = useLocalSearchParams<{ deckId?: string; collectionId?: string }>();

  const [q, setQ] = useState('');
  const [chip, setChip] = useState<ChipScope>('all');
  const [sort, setSort] = useState<SortMode>('smart');
  const [peek, setPeek] = useState<Card | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [sel, setSel] = useState<string[]>([]);
  const [filterOpen, setFilterOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [fLevels, setFLevels] = useState<CefrLevel[]>([]);
  const [fStatus, setFStatus] = useState<StatusFilter[]>([]);
  const [fDecks, setFDecks] = useState<string[]>([]);

  // arriving from a peek sheet's "Browse cards" — the route param must sync
  // into filter state whenever it changes (the tab stays mounted).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate one-render cascade on navigation; deriving instead would break "Clear filters".
    if (params.deckId) setFDecks([params.deckId]);
  }, [params.deckId]);

  const now = useNow();

  const cards = useMemo(() => {
    let pool = state.cards;
    if (params.collectionId) {
      const col = state.collections.find((x) => x.id === params.collectionId);
      if (col) {
        const f = collectionFilter(col.query);
        pool = pool.filter((x) => f(x, now));
      }
    }
    if (chip === 'due')
      pool = pool.filter((x) => {
        const s = displayState(x, now);
        return s === 'due' || s === 'learning';
      });
    if (chip === 'new') pool = pool.filter((x) => x.reps === 0);
    if (chip === 'fav') pool = pool.filter((x) => x.fav);

    if (fLevels.length) pool = pool.filter((x) => fLevels.includes(x.level));
    if (fDecks.length) pool = pool.filter((x) => fDecks.includes(x.deckId));
    if (fStatus.length) {
      pool = pool.filter((x) => {
        const s = displayState(x, now);
        return fStatus.some((f) => {
          if (f === 'Suspended') return !!x.suspended;
          if (f === 'Flagged') return !!x.flagged;
          return s === f.toLowerCase();
        });
      });
    }

    const parsed = parseQuery(q);
    if (parsed.level) pool = pool.filter((x) => x.level.toLowerCase() === parsed.level);
    if (parsed.type) pool = pool.filter((x) => x.type.toLowerCase() === parsed.type);
    if (parsed.deck) {
      pool = pool.filter((x) => {
        const deck = state.decks.find((d) => d.id === x.deckId);
        return deck?.name.toLowerCase().includes(parsed.deck!);
      });
    }
    if (parsed.text) {
      const s = parsed.text;
      pool = pool.filter(
        (x) =>
          x.word.toLowerCase().includes(s) ||
          x.tr.toLowerCase().includes(s) ||
          (x.ex ?? '').toLowerCase().includes(s),
      );
    }

    const sorted = [...pool];
    switch (sort) {
      case 'az':
        sorted.sort((a, b) => a.base.localeCompare(b.base));
        break;
      case 'newest':
        sorted.sort((a, b) => b.createdAt - a.createdAt);
        break;
      case 'hardest':
        sorted.sort((a, b) => a.ease - b.ease);
        break;
      default:
        sorted.sort(
          (a, b) =>
            STATE_PRIORITY[displayState(a, now)] - STATE_PRIORITY[displayState(b, now)] ||
            a.due - b.due,
        );
    }
    return sorted;
  }, [state.cards, state.decks, state.collections, params.collectionId, chip, q, sort, fLevels, fStatus, fDecks, now]);

  const toggleSel = (id: string) =>
    setSel(sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]);

  const bulk = (verb: string, patch: Partial<Card>) => {
    actions.setCardProps(sel, patch);
    show(`${sel.length} cards ${verb}`);
    setSel([]);
    setSelecting(false);
  };

  const studySelected = () => {
    const ids = sel.join(',');
    setSel([]);
    setSelecting(false);
    router.push({ pathname: '/session', params: { kind: 'scheduled', cardIds: ids, label: 'Selected cards' } });
  };

  const filtersActive =
    q !== '' || chip !== 'all' || fLevels.length > 0 || fStatus.length > 0 || fDecks.length > 0;

  const toggleIn = <T,>(arr: T[], v: T): T[] =>
    arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];

  const renderRow = ({ item, index }: { item: Card; index: number }) => {
    const s = displayState(item, now);
    const selected = sel.includes(item.id);
    return (
      <Pressable
        onPress={() => (selecting ? toggleSel(item.id) : setPeek(item))}
        style={({ pressed }) => ({ opacity: pressed ? 0.75 : 1 })}
      >
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            paddingVertical: 13,
            borderBottomWidth: index === cards.length - 1 ? 0 : 1,
            borderBottomColor: c.hairlineSoft,
          }}
        >
          {selecting && (
            <View
              style={{
                width: 22,
                height: 22,
                borderRadius: 7,
                borderWidth: selected ? 0 : 1.5,
                borderColor: c.hairlineStrong,
                backgroundColor: selected ? c.pine : 'transparent',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {selected && <Ion name="checkmark" size={14} color="#fff" />}
            </View>
          )}
          <View style={{ flex: 1, minWidth: 0 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text
                numberOfLines={1}
                style={[font('serif', 600), { fontSize: 17.5, color: c.ink, flexShrink: 1 }]}
              >
                {item.word}
              </Text>
              <StateDot state={s} />
            </View>
            <Text
              numberOfLines={1}
              style={[font('sans', 400), { fontSize: 13, color: c.ink2, marginTop: 1 }]}
            >
              {item.tr}
            </Text>
          </View>
          <LevelBadge level={item.level} />
          {item.fav ? (
            <Ion name="heart" size={16} color={c.danger} />
          ) : item.intervalDays > 0 && item.stepIndex === null ? (
            <Text
              style={[font('mono', 400), { fontSize: 11.5, color: c.ink3, minWidth: 28, textAlign: 'right' }]}
            >
              {formatIntervalDays(item.intervalDays)}
            </Text>
          ) : (
            <View style={{ minWidth: 16 }} />
          )}
        </View>
      </Pressable>
    );
  };

  const header = (
    <View>
      <ScreenHead
        title="Library"
        sub={`${state.cards.length.toLocaleString('en-US')} cards across ${state.decks.length} decks`}
        right={
          selecting ? (
            <Btn
              size="sm"
              kind="quiet"
              onPress={() => {
                setSelecting(false);
                setSel([]);
              }}
            >
              Cancel
            </Btn>
          ) : (
            <Btn size="sm" kind="quiet" onPress={() => setSelecting(true)}>
              Select
            </Btn>
          )
        }
      />

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
        <Ion name="search" size={17} color={c.ink3} />
        <TextInput
          value={q}
          onChangeText={setQ}
          placeholder="Search words, meanings, examples…"
          placeholderTextColor={c.ink3}
          autoCorrect={false}
          style={[font('sans', 400), { flex: 1, fontSize: 14.5, color: c.ink, padding: 0 }]}
        />
        {q !== '' && (
          <Pressable onPress={() => setQ('')} hitSlop={8}>
            <Ion name="close-circle" size={17} color={c.ink3} />
          </Pressable>
        )}
      </View>
      <Text style={[font('mono', 400), { fontSize: 11.5, color: c.ink3, marginTop: 8, marginHorizontal: 2 }]}>
        try <Text style={{ color: c.pine }}>level:B1</Text> ·{' '}
        <Text style={{ color: c.pine }}>type:verb</Text> ·{' '}
        <Text style={{ color: c.pine }}>{'deck:"Spanish"'}</Text>
      </Text>

      {/* scope chips */}
      <View style={{ flexDirection: 'row', gap: 8, paddingTop: 14, paddingBottom: 2, flexWrap: 'wrap' }}>
        <Chip active={chip === 'all'} onPress={() => setChip('all')}>
          All cards
        </Chip>
        <Chip active={chip === 'due'} icon="time-outline" onPress={() => setChip('due')}>
          Due
        </Chip>
        <Chip active={chip === 'new'} icon="sparkles-outline" onPress={() => setChip('new')}>
          New
        </Chip>
        <Chip active={chip === 'fav'} icon="heart-outline" onPress={() => setChip('fav')}>
          Favorites
        </Chip>
        <Chip
          icon="options-outline"
          active={fLevels.length + fStatus.length + fDecks.length > 0}
          onPress={() => setFilterOpen(true)}
        >
          Filters
        </Chip>
      </View>

      {/* results meta */}
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
          paddingTop: 12,
          paddingBottom: 2,
        }}
      >
        <Text style={[font('sans', 400), tnum, { fontSize: 12.5, color: c.ink3 }]}>
          {cards.length} {cards.length === 1 ? 'card' : 'cards'} · sorted {SORT_LABEL[sort]}
        </Text>
        <Pressable
          onPress={() => setSort(SORT_CYCLE[(SORT_CYCLE.indexOf(sort) + 1) % SORT_CYCLE.length])}
          hitSlop={8}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}
        >
          <Ion name="swap-vertical" size={13} color={c.pine} />
          <Text style={[font('sans', 700), { fontSize: 12.5, color: c.pine }]}>Sort</Text>
        </Pressable>
      </View>
    </View>
  );

  const empty = (
    <View style={{ alignItems: 'center', paddingVertical: 46, paddingHorizontal: 20 }}>
      <Ion name={state.cards.length === 0 ? 'library-outline' : 'search'} size={34} color={c.ink3} />
      <Text style={[font('serif', 600), { fontSize: 19, color: c.ink, marginTop: 12, marginBottom: 5 }]}>
        {state.cards.length === 0 ? 'Your library is empty' : `No matches${q ? ` for “${q}”` : ''}`}
      </Text>
      <Text
        style={[
          font('sans', 400),
          { fontSize: 13.5, color: c.ink3, marginBottom: 16, textAlign: 'center' },
        ]}
      >
        {state.cards.length === 0
          ? 'Add a card or import a deck to get started.'
          : 'Your cards are still here — the current search and filters exclude them.'}
      </Text>
      {state.cards.length === 0 ? (
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Btn kind="secondary" onPress={() => router.push('/card-editor')}>
            Add a card
          </Btn>
          <Btn onPress={() => router.push('/import')}>Import a deck</Btn>
        </View>
      ) : (
        <Btn
          kind="secondary"
          onPress={() => {
            setQ('');
            setChip('all');
            setFLevels([]);
            setFStatus([]);
            setFDecks([]);
          }}
        >
          Clear search & filters
        </Btn>
      )}
    </View>
  );

  return (
    <>
      <FlatList
        data={cards}
        keyExtractor={(item) => item.id}
        renderItem={renderRow}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        style={{ flex: 1, backgroundColor: c.paper }}
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingBottom: TABBAR_HEIGHT + insets.bottom + 24,
        }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      />

      {!selecting && (
        <FAB onPress={() => setCreateOpen(true)} bottom={TABBAR_HEIGHT + insets.bottom + 18} />
      )}

      {/* bulk action bar */}
      {selecting && sel.length > 0 && (
        <View
          style={[
            {
              position: 'absolute',
              left: 14,
              right: 14,
              bottom: TABBAR_HEIGHT + insets.bottom + 12,
              zIndex: 55,
              backgroundColor: c.inverseSurface,
              borderRadius: 16,
              paddingVertical: 11,
              paddingHorizontal: 14,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
            },
            c.shadow.lg,
          ]}
        >
          <Text
            style={[font('sans', 800), tnum, { fontSize: 13.5, color: c.inverseText, marginRight: 4 }]}
          >
            {sel.length}
          </Text>
          {(
            [
              ['heart-outline', 'favorited', { fav: true }],
              ['flag-outline', 'flagged', { flagged: true }],
              ['eye-off-outline', 'suspended', { suspended: true }],
            ] as [string, string, Partial<Card>][]
          ).map(([icon, verb, patch]) => (
            <Pressable
              key={icon}
              onPress={() => bulk(verb, patch)}
              style={{
                flex: 1,
                backgroundColor: 'rgba(255,255,255,0.1)',
                borderRadius: 10,
                paddingVertical: 8,
                alignItems: 'center',
              }}
            >
              <Ion name={icon} size={17} color={c.inverseText} />
            </Pressable>
          ))}
          <Pressable
            onPress={studySelected}
            style={{
              flex: 1.6,
              backgroundColor: c.inverseAccent,
              borderRadius: 10,
              paddingVertical: 8,
              alignItems: 'center',
            }}
          >
            <Text style={[font('sans', 800), { fontSize: 12.5, color: '#3A2A08' }]}>
              Study these
            </Text>
          </Pressable>
        </View>
      )}

      <CardPeek card={peek} onClose={() => setPeek(null)} />
      <CreateSheet open={createOpen} onClose={() => setCreateOpen(false)} />

      {/* filter sheet — chips hold real state */}
      <Sheet open={filterOpen} onClose={() => setFilterOpen(false)} title="Filters">
        <Overline style={{ marginBottom: 8 }}>Level</Overline>
        <View style={{ flexDirection: 'row', gap: 7, flexWrap: 'wrap', marginBottom: 16 }}>
          {LEVELS.map((l) => (
            <Chip key={l} active={fLevels.includes(l)} onPress={() => setFLevels(toggleIn(fLevels, l))}>
              {l}
            </Chip>
          ))}
        </View>
        <Overline style={{ marginBottom: 8 }}>Status</Overline>
        <View style={{ flexDirection: 'row', gap: 7, flexWrap: 'wrap', marginBottom: 16 }}>
          {STATUS_FILTERS.map((s) => (
            <Chip key={s} active={fStatus.includes(s)} onPress={() => setFStatus(toggleIn(fStatus, s))}>
              {s}
            </Chip>
          ))}
        </View>
        <Overline style={{ marginBottom: 8 }}>Deck</Overline>
        <View style={{ flexDirection: 'row', gap: 7, flexWrap: 'wrap', marginBottom: 20 }}>
          {state.decks.map((d) => (
            <Chip
              key={d.id}
              active={fDecks.includes(d.id)}
              onPress={() => setFDecks(toggleIn(fDecks, d.id))}
            >
              {`${d.flag} ${d.name}`}
            </Chip>
          ))}
        </View>
        <Btn full onPress={() => setFilterOpen(false)}>
          {filtersActive ? `Show ${cards.length} results` : 'Show results'}
        </Btn>
      </Sheet>
    </>
  );
}
