/**
 * Universal object peek (B1) — tap any deck or collection anywhere to get
 * the same sheet: composition bar, honest due count, Study / Browse / Edit.
 * Replaces the old app's hidden long-presses.
 */
import { useRouter } from 'expo-router';
import React, { useMemo } from 'react';
import { Text, View } from 'react-native';

import { Btn, DeckTag, DeckTile, Ion, SegBar, Sheet } from '@/components/ui';
import { collectionStats, deckStats } from '@/domain/queue';
import { Collection, Deck } from '@/domain/types';
import { normalizedDayDone, useData } from '@/store/DataContext';
import { useNow } from '@/store/useNow';
import { useSnackbar } from '@/store/SnackbarContext';
import { font, tnum } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

export type PeekTarget =
  | { kind: 'deck'; deck: Deck }
  | { kind: 'collection'; collection: Collection };

interface PeekSheetProps {
  target: PeekTarget | null;
  onClose: () => void;
}

function LegendDot({ color, label, n }: { color: string; label: string; n: number }) {
  const c = useColors();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
      <View style={{ width: 7, height: 7, borderRadius: 99, backgroundColor: color }} />
      <Text style={[font('sans', 400), tnum, { fontSize: 12, color: c.ink3 }]}>
        {label} {n}
      </Text>
    </View>
  );
}

export function PeekSheet({ target, onClose }: PeekSheetProps) {
  const c = useColors();
  const router = useRouter();
  const { state } = useData();
  const { show } = useSnackbar();
  const now = useNow();

  const info = useMemo(() => {
    if (!target) return null;
    if (target.kind === 'deck') {
      const s = deckStats(
        state.cards,
        target.deck.id,
        state.settings.srs,
        normalizedDayDone(state.person, now),
        now,
      );
      return { name: target.deck.name, count: s.total, due: s.due, stats: s };
    }
    const s = collectionStats(state.cards, target.collection, now);
    return { name: target.collection.name, count: s.count, due: s.due, stats: null };
  }, [target, state, now]);

  if (!target || !info) return null;
  const isColl = target.kind === 'collection';

  const study = (ahead: boolean) => {
    onClose();
    if (isColl) {
      router.push({
        pathname: '/session',
        params: {
          kind: ahead ? 'ahead' : 'collection',
          collectionId: target.collection.id,
          label: target.collection.name,
        },
      });
    } else {
      router.push({
        pathname: '/session',
        params: { kind: ahead ? 'ahead' : 'deck', deckId: target.deck.id, label: target.deck.name },
      });
    }
  };

  const browse = () => {
    onClose();
    router.push({
      pathname: '/(tabs)/browse',
      params: isColl ? { collectionId: target.collection.id } : { deckId: target.deck.id },
    });
  };

  const edit = () => {
    onClose();
    if (isColl) {
      // Intentional stub (WIRING.md §3): the collection editor is not built.
      show('Collection editor — filters, sort & status');
    } else {
      router.push({ pathname: '/deck-editor', params: { deckId: target.deck.id } });
    }
  };

  return (
    <Sheet open onClose={onClose}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 13, marginBottom: 4 }}>
        {isColl ? (
          <View
            style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              backgroundColor: c.pineTint,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Ion name={target.collection.icon} size={20} color={c.pine} />
          </View>
        ) : (
          <DeckTile flag={target.deck.flag} size={44} builtin={target.deck.builtin} ring={c.surface} />
        )}
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[font('serif', 600), { fontSize: 21, color: c.ink, lineHeight: 24 }]}>
            {info.name}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 }}>
            {!isColl && <DeckTag builtin={target.deck.builtin} />}
            <Text style={[font('sans', 400), tnum, { fontSize: 13, color: c.ink3 }]}>
              {info.count.toLocaleString('en-US')} cards
              {info.due > 0 ? ` · ${info.due} due now` : ' · caught up'}
            </Text>
          </View>
        </View>
      </View>

      {!isColl && info.stats && (
        <View style={{ marginTop: 14, marginBottom: 4 }}>
          <SegBar
            mastered={info.stats.mastered}
            learning={info.stats.learning}
            neww={info.stats.neww}
            total={info.stats.total}
            h={5}
          />
          <View style={{ flexDirection: 'row', gap: 14, marginTop: 8 }}>
            <LegendDot color={c.pine} label="Mastered" n={info.stats.mastered} />
            <LegendDot color={c.amber} label="Learning" n={info.stats.learning} />
            <LegendDot color={c.info} label="New" n={info.stats.neww} />
          </View>
        </View>
      )}
      {isColl && (
        <Text
          style={[
            font('serif', 400, true),
            { fontSize: 14.5, color: c.ink2, marginTop: 6, marginBottom: 2 },
          ]}
        >
          {target.collection.desc}
        </Text>
      )}

      <View style={{ gap: 10, marginTop: 18 }}>
        <Btn full size="lg" icon="play" onPress={() => study(info.due === 0)}>
          {info.due > 0 ? `Study ${info.due} due` : 'Nothing due — study ahead'}
        </Btn>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Btn kind="secondary" icon="search" onPress={browse} style={{ flex: 1 }} full>
            Browse cards
          </Btn>
          <Btn kind="secondary" icon="pencil" onPress={edit} style={{ flex: 1 }} full>
            Edit
          </Btn>
        </View>
      </View>
    </Sheet>
  );
}
