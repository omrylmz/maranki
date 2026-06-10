/**
 * Global create menu (B2): card · deck · collection · import.
 */
import { useRouter } from 'expo-router';
import React from 'react';
import { View } from 'react-native';

import { ListRow, Sheet } from '@/components/ui';
import { useSnackbar } from '@/store/SnackbarContext';
import { useColors } from '@/theme/ThemeContext';

interface CreateSheetProps {
  open: boolean;
  onClose: () => void;
}

export function CreateSheet({ open, onClose }: CreateSheetProps) {
  const c = useColors();
  const router = useRouter();
  const { show } = useSnackbar();

  const go = (fn: () => void) => () => {
    onClose();
    fn();
  };

  return (
    <Sheet open={open} onClose={onClose} title="Create">
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
    </Sheet>
  );
}
