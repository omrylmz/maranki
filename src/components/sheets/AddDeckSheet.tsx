/**
 * "Add a deck" — a two-level, by-language create surface. ONE component.
 *
 * Level 0 lists curated LANGUAGES (not decks): the menu stays legible no matter
 * how many curated decks or languages ship — nothing curated is auto-added, and
 * a language's decks are only revealed once it's chosen. Level 1 lists that
 * language's filter-ready decks with an honest Add / Added affordance.
 *
 * Two scopes:
 *  - scope="curated" (Library FAB): the curated catalog only. When every curated
 *    deck is already in the library, a gentle all-set note points to Study's +.
 *  - scope="all" (Study FAB + Collections "+ New"): the curated catalog PLUS an
 *    "Other ways" section (New card · New deck · New collection · Import).
 *
 * Adding a deck keeps the sheet OPEN and recomputes "Added" straight from store
 * state (no local mirror), so the affordance stays honest.
 */
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Btn, DeckTile, Ion, LevelBadge, ListRow, Overline, Sheet } from '@/components/ui';
import { CURATED_DECKS, CURATED_LANGUAGES } from '@/domain/deckCatalog';
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

  // Which language the user has drilled into (null = the language list).
  const [langName, setLangName] = useState<string | null>(null);

  // Always dismiss back to the language list, so reopening starts at level 0.
  const handleClose = () => {
    setLangName(null);
    onClose();
  };

  const go = (fn: () => void) => () => {
    handleClose();
    fn();
  };

  // "Added" means the deck exists AND is active — a paused deck is re-offered.
  const isAdded = (id: string) => state.decks.some((d) => d.id === id && d.active);

  const group = langName ? (CURATED_LANGUAGES.find((g) => g.deckLang === langName) ?? null) : null;
  const allCuratedAdded = CURATED_DECKS.every((entry) => isAdded(entry.id));
  const showAllSet = scope === 'curated' && allCuratedAdded;

  return (
    <Sheet open={open} onClose={handleClose} title={group ? `${group.flag}  ${group.deckLang}` : 'Add a deck'}>
      {group ? (
        /* ---------- level 1: a language's decks ---------- */
        <View>
          <Pressable
            onPress={() => setLangName(null)}
            hitSlop={6}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
              paddingVertical: 6,
              marginBottom: 2,
            }}
          >
            <Ion name="chevron-back" size={16} color={c.pine} />
            <Text style={[font('sans', 700), { fontSize: 13.5, color: c.pine }]}>All languages</Text>
          </Pressable>
          {group.decks.map((entry, i) => {
            const added = isAdded(entry.id);
            return (
              <View
                key={entry.id}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 12,
                  paddingVertical: 12,
                  borderBottomWidth: i === group.decks.length - 1 ? 0 : 1,
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
                      // existing-but-paused → addCatalogDeck reactivates it
                      const resumed = state.decks.some((d) => d.id === entry.id);
                      actions.addCatalogDeck(entry.id);
                      show(`${entry.name} ${resumed ? 'resumed' : 'added to your library'}`);
                    }}
                  >
                    Add
                  </Btn>
                )}
              </View>
            );
          })}
        </View>
      ) : showAllSet ? (
        /* ---------- every curated deck already added ---------- */
        <View>
          <Overline>Browse curated decks</Overline>
          <View style={{ paddingTop: 12, paddingBottom: 6 }}>
            <Text style={[font('serif', 600), { fontSize: 16, color: c.ink, marginBottom: 4 }]}>
              Every curated deck is in your library
            </Text>
            <Text style={[font('sans', 400), { fontSize: 13, color: c.ink3, lineHeight: 19 }]}>
              File, Anki, and AnkiWeb imports live under the Study tab&apos;s +.
            </Text>
          </View>
        </View>
      ) : (
        /* ---------- level 0: the language list (+ other ways) ---------- */
        <View>
          <Overline>Browse curated decks</Overline>
          <View style={{ marginTop: 8 }}>
            {CURATED_LANGUAGES.map((g, i) => {
              const cards = g.decks.reduce((n, d) => n + d.specs.length, 0);
              const added = g.decks.filter((d) => isAdded(d.id)).length;
              const allAdded = added === g.decks.length;
              return (
                <Pressable
                  key={g.deckLang}
                  onPress={() => setLangName(g.deckLang)}
                  style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 12,
                    paddingVertical: 12,
                    borderBottomWidth: i === CURATED_LANGUAGES.length - 1 ? 0 : 1,
                    borderBottomColor: c.hairlineSoft,
                    opacity: pressed ? 0.6 : 1,
                  })}
                >
                  <DeckTile flag={g.flag} builtin size={38} ring={c.surface} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={[font('sans', 700), { fontSize: 15.5, color: c.ink }]}>
                      {g.deckLang}
                    </Text>
                    <Text
                      numberOfLines={1}
                      style={[font('sans', 400), { fontSize: 12.5, color: c.ink3, marginTop: 2 }]}
                    >
                      {g.decks.length} {g.decks.length === 1 ? 'deck' : 'decks'} · {cards} cards
                      {added > 0 ? ` · ${added} added` : ''}
                    </Text>
                  </View>
                  {allAdded ? (
                    <Ion name="checkmark-circle" size={18} color={c.success} />
                  ) : (
                    <Ion name="chevron-forward" size={18} color={c.ink3} />
                  )}
                </Pressable>
              );
            })}
          </View>

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
        </View>
      )}
    </Sheet>
  );
}
