/**
 * Settings › Your data (spec §8.4, §8.6, unit W4-5).
 *
 *   Import                        Anki .apkg, .csv or AnkiWeb                    ›
 *   Export a backup               Everything: decks, cards, progress, settings.  ›
 *   Restore a backup              Replace everything on this phone with a backup file.
 *   Include images in backups     [toggle]
 *   Automatic backups             [toggle]  Keep the last 3 weekly backups on this phone.
 *     ⏱ Weekly backup  12 Oct 2026, 21:04 · 2.9 MB   [Share] [Restore]
 *   Export study history (CSV)    Your sessions and every review, in one .zip    ›
 *
 * Every row is real:
 *   - "Export a backup" writes one backup file — the whole state, the review
 *     history and (when "Include images in backups" is on and they fit in
 *     50 MB) the images — and opens the share sheet (src/store/backup.ts).
 *   - "Restore a backup" runs the Restore flow (RestoreFlow.tsx).
 *   - "Automatic backups" + the list: BackupRows.tsx.
 *   - "Export study history (CSV)" shares ONE zip with the sessions CSV and
 *     the review CSV (src/store/history.ts, spec §8.8).
 *
 * Only one export runs at a time (no double taps, no two share sheets), and
 * "Preparing…" shows on the row of the export that runs — never on the other
 * one (`exporting` keeps WHICH export runs).
 */
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { Text, View } from 'react-native';

import { BackupRows } from '@/components/data/BackupRows';
import { useRestoreFlow } from '@/components/data/RestoreFlow';
import { PAGE_TITLE } from '@/components/settings/settingsIndex';
import { InfoButton } from '@/components/sheets/InfoButton';
import { ListRow, Page, Row, SectionHead, StackBar, Toggle } from '@/components/ui';
import {
  exportBackup,
  exportHistoryZip,
  type ExportKind,
  exportMessage,
  exportRowSub,
  fullBackupIO,
  historyMessage,
} from '@/store/backup';
import { useData } from '@/store/DataContext';
import { historyFiles, historyZip } from '@/store/history';
import { useSnackbar } from '@/store/SnackbarContext';
import { appRevlogStore } from '@/store/storage';
import { font } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

export default function YourDataScreen() {
  const c = useColors();
  const router = useRouter();
  const { state, actions } = useData();
  const { show } = useSnackbar();
  const restore = useRestoreFlow();
  // Which export runs now, or null. One guard for both rows (never two exports
  // at once); the row that runs says "Preparing…".
  const [exporting, setExporting] = useState<ExportKind | null>(null);

  const doExport = async () => {
    if (exporting) return;
    setExporting('backup');
    const outcome = await exportBackup(state, Date.now(), fullBackupIO(appRevlogStore()), {
      images: state.settings.backupImages,
    });
    setExporting(null);
    // The share sheet is the answer; a message only when it could not open,
    // nothing was written, or the images were left out.
    const message = exportMessage(outcome);
    if (message) show(message);
  };

  const doHistory = async () => {
    if (exporting) return;
    setExporting('history');
    const outcome = await exportHistoryZip(
      state,
      Date.now(),
      // The file name is made by exportHistoryZip (local time).
      async (s) => ({ bytes: historyZip(await historyFiles(s)) }),
      fullBackupIO(appRevlogStore()),
    );
    setExporting(null);
    const message = historyMessage(outcome);
    if (message) show(message);
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.paper }}>
      <StackBar title={PAGE_TITLE.data} onBack={() => router.back()} />
      <Page pad={20}>
        <SectionHead action={<InfoButton term="Backup" />}>Backups and import</SectionHead>
        <ListRow
          icon="cloud-download-outline"
          title="Import"
          sub="Anki .apkg, .csv or AnkiWeb"
          onPress={() => router.push('/import')}
        />
        <ListRow
          icon="share-outline"
          title="Export a backup"
          sub={exportRowSub('backup', exporting)}
          onPress={() => void doExport()}
        />
        <ListRow
          icon="refresh-circle-outline"
          title="Restore a backup"
          sub="Replace everything on this phone with a backup file."
          onPress={restore.pickFile}
          last
        />
        <Row padV={12}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={[font('sans', 700), { fontSize: 15, color: c.ink }]}>Include images in backups</Text>
            <Text style={[font('sans', 400), { fontSize: 12.5, color: c.ink3, marginTop: 1 }]}>
              Imported card images, when together they are 50 MB or less.
            </Text>
          </View>
          <Toggle
            on={state.settings.backupImages}
            label="Include images in backups"
            onChange={(on) => actions.updateAppSettings({ backupImages: on })}
          />
        </Row>

        <SectionHead>On this phone</SectionHead>
        <BackupRows onRestore={restore.openBackup} restoring={restore.busy} />

        <SectionHead>Study history</SectionHead>
        <ListRow
          icon="document-text-outline"
          title="Export study history (CSV)"
          sub={exportRowSub('history', exporting)}
          onPress={() => void doHistory()}
          last
        />
      </Page>
      {restore.sheet}
    </View>
  );
}
