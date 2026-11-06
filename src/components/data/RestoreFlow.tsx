/**
 * The Restore flow (spec §8.4) — the same steps from every place that can
 * restore: Settings › Your data "Restore a backup", the Import screen's
 * "Backup" tab, and "Restore" on a backup kept on the phone.
 *
 *   1. Choose a file (the system picker; Cancel → nothing happens), or open a
 *      backup from the phone's backups folder.
 *   2. Read it: decodeBackup() → migrate(), the SAME migrate as the boot load
 *      (src/store/backup.ts `readBackup`). So a v2.0.2 backup restores too.
 *   3. Not a backup → "This file is not a Maranki backup."; made by a newer
 *      app → "This backup was made by a newer version of Maranki. Update the
 *      app first." Nothing is changed.
 *   4. RestoreConfirmSheet: what the backup holds, and a 1-second hold.
 *   5. Keep the current data (WITH its review history) as
 *      before-restore-<stamp>.json, then `actions.restore(state, history)`
 *      (replace everything, the backup's review history too, in ONE
 *      transaction), wait for the save (`actions.flush()`), and only when
 *      the save worked write the backup's images and say
 *      "Restored — 3 decks, 1,240 cards.". A backup WITHOUT review history
 *      keeps the phone's current history instead (it goes into the same
 *      transaction), and the confirm sheet says so first (wave 5b R2). Whether there is a history to keep is
 *      read from the history TABLE when the file is reviewed
 *      (`keptHistoryCount`), not from the undo window of the state: the
 *      two can differ (migrate() may drop a log entry whose row stays).
 *      If the safety copy cannot be
 *      written, NOTHING is restored. If the save fails (`flush()` resolves
 *      `{ ok: false }`), the snackbar says that the RESTORE was not saved,
 *      never "Restored". This order lives in `performRestore`
 *      (src/store/backup.ts), so its tests pin it.
 *
 * The disk is `fullBackupIO(appRevlogStore())`: the backups folder plus the
 * review history (the row store's `revlog` table) and the deck images.
 *
 * Use:
 *   const restore = useRestoreFlow();
 *   <ListRow title="Restore a backup" onPress={restore.pickFile} />
 *   {restore.sheet}
 * The screen must render `restore.sheet`, and it must have a SnackbarHost
 * (the messages use the global snackbar).
 */
import React, { useState } from 'react';

import type { RevlogRow } from '@/domain/model';
import type { DataState } from '@/domain/types';
import type { BackupMedia } from '@/platform/backupFile';
import { pickJsonFile, readBackupFile, type PickedFile } from '@/platform/files';
import {
  fullBackupIO,
  keptHistoryCount,
  performRestore,
  readBackup,
  RESTORE_COPY,
  restoreProblem,
  restoreResultMessage,
  restoreSummary,
  type RestoreSummary,
} from '@/store/backup';
import { useData } from '@/store/DataContext';
import { useSnackbar } from '@/store/SnackbarContext';
import { appRevlogStore } from '@/store/storage';

import { RestoreConfirmSheet } from './RestoreConfirmSheet';

/** A backup that was read and is waiting for the hold. */
interface PendingRestore {
  state: DataState;
  summary: RestoreSummary;
  /** The backup's review history (written with the replace-all) and images (written after the save). */
  extras: { revlog: RevlogRow[]; media: BackupMedia[] };
}

export interface RestoreFlow {
  /** Step 1 with the system file picker. */
  pickFile: () => void;
  /** Step 1 with a file from the phone's backups folder (its name, e.g. 'auto-2026-10-21-18-04-07.json'). */
  openBackup: (name: string) => void;
  /** True while a file is read or a restore runs. */
  busy: boolean;
  /** The confirm sheet. Render it once in the screen. */
  sheet: React.ReactElement;
}

export function useRestoreFlow(options: { onRestored?: () => void } = {}): RestoreFlow {
  const { onRestored } = options;
  const { state, actions } = useData();
  const { show } = useSnackbar();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<PendingRestore | null>(null);

  /** Step 2–4: read the file's text; show the problem, or open the confirm sheet. */
  const review = async (file: PickedFile) => {
    if (file.tooBig) {
      show(RESTORE_COPY.notBackup);
      return;
    }
    const read = readBackup(file.text, Date.now());
    const problem = restoreProblem(read);
    if (problem !== null || read.kind !== 'ok') {
      show(problem ?? RESTORE_COPY.notBackup);
      return;
    }
    // An old export (raw state, no envelope) has no date inside: use the file's date.
    const at = read.info.exportedAt ?? file.modifiedAt;
    const extras = { revlog: read.revlog, media: read.media };
    // A backup without review history keeps the phone's own: the sheet says so when the
    // history TABLE has rows that the restore writes back (never rejects).
    const kept = await keptHistoryCount(read.state, extras, fullBackupIO(appRevlogStore()));
    setPending({ state: read.state, summary: restoreSummary(read.state, at, kept), extras });
    setOpen(true);
  };

  /** Read one file (from the picker or the backups folder), then review it. */
  const load = async (read: () => Promise<PickedFile | null>) => {
    if (busy) return;
    setBusy(true);
    try {
      const file = await read();
      if (file) await review(file);
    } catch {
      show(RESTORE_COPY.unreadable);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Step 5, after the 1-second hold: performRestore() keeps the safety copy
   * FIRST, then restores, then waits for the save, then writes the history
   * and images (it never rejects).
   */
  const confirm = () => {
    if (!pending || busy) return;
    const { state: next, summary, extras } = pending;
    setBusy(true);
    void performRestore({
      current: state,
      next,
      now: Date.now(),
      // The review history goes INTO the replace-all's transaction (never a second write after it).
      restore: (restored, history) => actions.restore(restored, history),
      // The engine's flush (EngineActions): it resolves whether the
      // replace-all committed, so a failed restore is never called a success.
      flush: () => actions.flush(),
      extras,
      io: fullBackupIO(appRevlogStore()),
    }).then((result) => {
      setOpen(false);
      setBusy(false);
      show(restoreResultMessage(result, summary));
      // The data was replaced (saved or not): the caller may leave the screen.
      if (result === 'restored' || result === 'restored-incomplete' || result === 'write-failed') onRestored?.();
    });
  };

  const sheet = (
    <RestoreConfirmSheet
      open={open}
      summary={pending?.summary ?? null}
      busy={busy}
      onConfirm={confirm}
      onCancel={() => setOpen(false)}
      onClosed={() => setPending(null)}
    />
  );

  return {
    pickFile: () => void load(pickJsonFile),
    openBackup: (name) => void load(() => readBackupFile(name)),
    busy,
    sheet,
  };
}
