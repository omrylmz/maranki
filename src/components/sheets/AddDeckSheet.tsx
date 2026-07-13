/**
 * "Add a deck" — the create surface. ONE component, shown from Home's welcome,
 * the Study FAB, and the Collections "+ New": New card · New deck · New
 * collection · Import (CSV · Anki file · AnkiWeb). Blank-slate app — there is no
 * curated catalog to browse, so every deck starts from a create or import.
 */
import { useRouter } from 'expo-router';
import React from 'react';
import { View } from 'react-native';

import { ListRow, Overline, Sheet } from '@/components/ui';
import { useSnackbar } from '@/store/SnackbarContext';
import { useColors } from '@/theme/ThemeContext';

interface AddDeckSheetProps {
  open: boolean;
  onClose: () => void;
}

export function AddDeckSheet({ open, onClose }: AddDeckSheetProps) {
  const c = useColors();
  const router = useRouter();
  const { show } = useSnackbar();

  const go = (fn: () => void) => () => {
    onClose();
    fn();
  };

  return (
    <Sheet open={open} onClose={onClose} title="Add a deck">
      <Overline style={{ marginBottom: 4 }}>Other ways</Overline>
      <ListRow
        icon="document-text-outline"
        title="New card"
        sub="Add a card to any deck"
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
    </Sheet>
  );
}
