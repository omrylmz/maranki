/**
 * BackupRows — the "Automatic backups" switch and the backups kept on this
 * phone, for Settings › Your data (spec §8.4, §8.6).
 *
 *   Automatic backups                                    [toggle]
 *   Keep the last 3 weekly backups on this phone.
 *   ⏱ Weekly backup     12 Oct 2026, 21:04 · 2.9 MB   [Share] [Restore]
 *   ↶ Before a restore  10 Oct 2026, 08:12 · 2.8 MB   [Share] [Restore] 🗑
 *
 * The list holds the weekly backups (src/store/autoBackup.ts), the copies made
 * before a restore, and exports kept on the phone: the Erase sheet's export,
 * an export made when sharing was not available, and the OLD exports that
 * v2.0.x wrote to the root of the app's document folder (all "Saved export").
 * It is read from disk once and read again whenever the
 * app writes or deletes a backup (`refreshBackupList` in src/store/backup.ts),
 * through React's useSyncExternalStore — the screen never reads the disk on
 * its own.
 *
 * "Restore" is handed to the parent (`onRestore`), which owns the one Restore
 * flow and its confirm sheet (RestoreFlow.tsx).
 *
 * "Delete" (the trash icon, W2 hardening; the UI kit's IconBtn since W3-7:
 * labelled, with an explicit disabled state): only on an export or a copy made
 * before a restore that lives in the backups folder (`canDeleteBackup`).
 * Every export of the Erase sheet adds a full-library file, so the user needs
 * a way to free that space. It asks first ("Delete this backup?"), because a
 * deleted backup cannot come back. Weekly backups are pruned by the app, and
 * an OLD v2.0.x export is never deleted, so neither shows the icon.
 */
import React, { useState, useSyncExternalStore } from 'react';
import { Text, View } from 'react-native';

import { A11Y_HIDDEN, Btn, IconBtn, Ion, Row, Sheet, Toggle } from '@/components/ui';
import { SHARE_BACKUP, shareFile } from '@/platform/share';
import {
  BACKUP_KIND_LABEL,
  type BackupEntry,
  backupSettingsPatch,
  canDeleteBackup,
  DELETE_BACKUP_COPY,
  deleteBackupLine,
  deleteKeptBackup,
  formatBackupDate,
  formatBytes,
  getBackupList,
  readBackupSettings,
  SHARE_COPY,
  subscribeBackupList,
} from '@/store/backup';
import { useData } from '@/store/DataContext';
import { useSnackbar } from '@/store/SnackbarContext';
import { font, tnum } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

const KIND_ICON: Record<BackupEntry['kind'], string> = {
  auto: 'time-outline',
  beforeRestore: 'arrow-undo-outline',
  export: 'document-outline',
};

interface BackupRowsProps {
  /** Start the Restore flow with this file of the backups folder. */
  onRestore: (name: string) => void;
  /** True while a restore is being read or done: the Restore and Delete buttons wait. */
  restoring?: boolean;
}

export function BackupRows({ onRestore, restoring }: BackupRowsProps) {
  const c = useColors();
  const { state, actions } = useData();
  const { show } = useSnackbar();
  const list = useSyncExternalStore(subscribeBackupList, getBackupList, getBackupList);
  const { autoBackup } = readBackupSettings(state.settings);
  /** The backup the confirm sheet asks about (null = the sheet is closed). */
  const [toDelete, setToDelete] = useState<BackupEntry | null>(null);
  /** Kept while the sheet slides out, so its text does not flash away. */
  const [shown, setShown] = useState<BackupEntry | null>(null);

  const askDelete = (entry: BackupEntry) => {
    setShown(entry);
    setToDelete(entry);
  };

  const confirmDelete = () => {
    if (!toDelete) return;
    const entry = toDelete;
    setToDelete(null);
    show(deleteKeptBackup(entry) ? DELETE_BACKUP_COPY.deleted : DELETE_BACKUP_COPY.failed);
  };

  const share = async (entry: BackupEntry) => {
    try {
      if (!(await shareFile(entry.uri, SHARE_BACKUP))) show(SHARE_COPY.unavailable);
    } catch {
      show(SHARE_COPY.failed);
    }
  };

  const note = (text: string) => (
    <Text style={[font('sans', 400), { fontSize: 12.5, lineHeight: 18, color: c.ink3, paddingVertical: 10 }]}>
      {text}
    </Text>
  );

  return (
    <View>
      <Row padV={12}>
        <View style={{ flex: 1 }}>
          <Text style={[font('sans', 700), { fontSize: 15, color: c.ink }]}>Automatic backups</Text>
          <Text style={[font('sans', 400), { fontSize: 12.5, color: c.ink3, marginTop: 1 }]}>
            Keep the last 3 weekly backups on this phone.
          </Text>
        </View>
        <Toggle
          on={autoBackup}
          label="Automatic backups"
          onChange={(on) => actions.updateAppSettings(backupSettingsPatch({ autoBackup: on }))}
        />
      </Row>

      {list.failed
        ? note("We couldn't read the backups on this phone.")
        : list.files.length === 0
          ? note('No backups on this phone yet.')
          : list.files.map((entry, i) => (
              <Row key={entry.name} padV={11} last={i === list.files.length - 1}>
                <View {...A11Y_HIDDEN}>
                  <Ion name={KIND_ICON[entry.kind]} size={17} color={c.ink3} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text numberOfLines={1} style={[font('sans', 700), { fontSize: 14, color: c.ink }]}>
                    {BACKUP_KIND_LABEL[entry.kind]}
                  </Text>
                  <Text
                    numberOfLines={1}
                    style={[font('sans', 400), tnum, { fontSize: 12, color: c.ink3, marginTop: 1 }]}
                  >
                    {entry.at !== null ? formatBackupDate(entry.at) : 'Date unknown'} · {formatBytes(entry.size)}
                  </Text>
                </View>
                <Btn size="sm" kind="quiet" onPress={() => void share(entry)}>
                  Share
                </Btn>
                <Btn size="sm" kind="secondary" disabled={restoring} onPress={() => onRestore(entry.name)}>
                  Restore
                </Btn>
                {canDeleteBackup(entry) ? (
                  // The UI kit's IconBtn: role "button", the label, and an
                  // explicit accessibilityState { disabled } while a restore
                  // runs, so a screen reader says "dimmed" / "disabled".
                  // 34 pt + its hitSlop = a 46 pt touch target (spec §8.12: ≥ 44 pt).
                  <IconBtn
                    icon="trash-outline"
                    size={34}
                    iconSize={17}
                    color={c.danger}
                    label={DELETE_BACKUP_COPY.button}
                    disabled={restoring}
                    onPress={() => askDelete(entry)}
                  />
                ) : null}
              </Row>
            ))}

      <Sheet
        open={toDelete !== null}
        onClose={() => setToDelete(null)}
        onClosed={() => setShown(null)}
        title={DELETE_BACKUP_COPY.title}
      >
        <Text style={[font('sans', 400), tnum, { fontSize: 14.5, lineHeight: 21, color: c.ink2, marginBottom: 18 }]}>
          {shown ? deleteBackupLine(shown) : ''}
        </Text>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Btn kind="secondary" full style={{ flex: 1 }} onPress={() => setToDelete(null)}>
            {DELETE_BACKUP_COPY.cancel}
          </Btn>
          <Btn kind="dangerSolid" full style={{ flex: 1 }} onPress={confirmDelete}>
            {DELETE_BACKUP_COPY.confirm}
          </Btn>
        </View>
      </Sheet>
    </View>
  );
}
