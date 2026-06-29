/**
 * "Add a deck" — the differentiated create surface. ONE component, two scopes:
 *
 *  - scope="curated" (Library FAB): the app's built-in, FILTER-READY decks only.
 *    These carry real per-card level/type, so adding one immediately populates
 *    the Library's level:/type: filters and badges. When every curated deck is
 *    already in the library, a gentle all-set note points to the Study tab's +
 *    for file/Anki/AnkiWeb imports.
 *
 *  - scope="all" (Study FAB + Collections "+ New"): the curated decks PLUS an
 *    "Other ways" section mirroring the old global create menu (New card · New
 *    deck · New collection · Import).
 *
 * Adding a curated deck keeps the sheet OPEN: the row recomputes to "Added"
 * straight from store state (no local mirror), so the affordance is honest.
 */
import { useRouter } from 'expo-router';
import React from 'react';
import { Text, View } from 'react-native';

import {
  Btn,
  DeckTile,
  Ion,
  LevelBadge,
  ListRow,
  Overline,
  Sheet,
} from '@/components/ui';
import { CURATED_DECKS } from '@/domain/deckCatalog';
import { useData } from '@/store/DataContext';
import { useSnackbar } from '@/store/SnackbarContext';
import { font } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

interface AddDeckSheetProps {
  open: boolean;
  onClose: () => void;
  scope: 'curated' | 'all';
}

export function AddDeckSheet({ open, onClose, scope }: AddDeckSheetProps) {
  const c = useColors();
  const router = useRouter();
  const { state, actions } = useData();
  const { show } = useSnackbar();

  const go = (fn: () => void) => () => {
    onClose();
    fn();
  };

  // "Added" means the deck exists AND is active — a paused deck is re-offered.
  const isAdded = (id: string) => state.decks.some((d) => d.id === id && d.active);
  const allAdded = CURATED_DECKS.every((entry) => isAdded(entry.id));
  const showAllSet = scope === 'curated' && allAdded;

  return (
    <Sheet open={open} onClose={onClose} title="Add a deck">
      <Overline>Curated · filter-ready</Overline>

      {showAllSet ? (
        <View style={{ paddingTop: 12, paddingBottom: 6 }}>
          <Text style={[font('serif', 600), { fontSize: 16, color: c.ink, marginBottom: 4 }]}>
            Every curated deck is in your library
          </Text>
          <Text style={[font('sans', 400), { fontSize: 13, color: c.ink3, lineHeight: 19 }]}>
            File, Anki, and AnkiWeb imports live under the Study tab&apos;s +.
          </Text>
        </View>
      ) : (
        <View style={{ marginTop: 8 }}>
          {CURATED_DECKS.map((entry, i) => {
            const added = isAdded(entry.id);
            return (
              <View
                key={entry.id}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 12,
                  paddingVertical: 12,
                  borderBottomWidth: i === CURATED_DECKS.length - 1 ? 0 : 1,
                  borderBottomColor: c.hairlineSoft,
                }}
              >
                {/* ring = sheet surface, so the provenance seal reads as a sticker */}
                <DeckTile flag={entry.flag} builtin size={38} ring={c.surface} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Text
                      numberOfLines={1}
                      style={[font('sans', 700), { fontSize: 15.5, color: c.ink, flexShrink: 1 }]}
                    >
                      {entry.name}
                    </Text>
                    {entry.level != null && <LevelBadge level={entry.level} />}
                  </View>
                  <Text
                    numberOfLines={1}
                    style={[font('sans', 400), { fontSize: 12.5, color: c.ink3, marginTop: 2 }]}
                  >
                    {entry.specs.length} cards · {entry.deckLang}
                  </Text>
                </View>
                {added ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                    <Ion name="checkmark-circle" size={17} color={c.success} />
                    <Text style={[font('sans', 700), { fontSize: 13, color: c.ink3 }]}>Added</Text>
                  </View>
                ) : (
                  <Btn
                    size="sm"
                    onPress={() => {
                      actions.addCatalogDeck(entry.id);
                      show(`${entry.name} added to your library`);
                    }}
                  >
                    Add
                  </Btn>
                )}
              </View>
            );
          })}
        </View>
      )}

      {scope === 'all' && (
        <>
          <View style={{ height: 1, backgroundColor: c.hairlineStrong, marginVertical: 6 }} />
          <Overline style={{ marginBottom: 4 }}>Other ways</Overline>
          <ListRow
            icon="document-text-outline"
            title="New card"
            sub="Add a word to any deck"
            onPress={go(() => router.push('/card-editor'))}
          />
          <ListRow
            icon="albums-outline"
            title="New deck"
            sub="A fresh collection of cards"
            onPress={go(() => router.push('/deck-editor'))}
          />
          <ListRow
            icon="funnel-outline"
            title="New collection"
            sub="A saved smart filter — always up to date"
            onPress={go(() => show('Collection editor — saved smart filters'))}
          />
          <View style={{ height: 1, backgroundColor: c.hairlineStrong, marginVertical: 6 }} />
          <ListRow
            icon="cloud-download-outline"
            iconColor={c.info}
            iconBg={c.infoTint}
            title="Import"
            sub="CSV · Anki file · AnkiWeb"
            onPress={go(() => router.push('/import'))}
            last
          />
        </>
      )}
    </Sheet>
  );
}
