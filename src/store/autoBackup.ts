/**
 * Automatic backups (spec §8.4, unit W2-2): once a week, the app keeps a
 * backup of everything on the phone, in Paths.document/backups/auto-<stamp>.json.
 * Only the newest 3 are kept. Settings › Your data lists them with "Share" and
 * "Restore" (src/components/data/BackupRows.tsx).
 *
 * WHY: most people never press "Export a backup". A weekly copy on the phone
 * still saves them from a bad import, a wrong restore or a bug in a new
 * version (it is not a copy OFF the phone — for that, "Export a backup").
 *
 * When a backup is written (`runAutoBackup`), ALL of these must be true:
 *   1. the data is loaded (`ready`);
 *   2. the data is NOT read-blocked ('read' / 'too-new' / 'migrate'). Then the
 *      state in memory is only the blank seed, not the user's data, and a
 *      "backup" of it would push a real backup out of the newest 3 (C1);
 *   3. "Automatic backups" is on (`settings.autoBackup`, default on);
 *   4. the library holds something (a deck, a card or a session) — same reason
 *      as 2: after "Erase everything" the old backups must stay;
 *   5. the newest automatic backup is 7 days old or older, or there is none.
 * The age comes from the backup FILES (the time stamp in each name, local
 * time since wave 5b: backup.ts `localFileStamp`), not from a stored date:
 * after a restore from another phone, the stored date may say "yesterday"
 * while this phone has no backup at all.
 *
 * A new backup is written FIRST, and only then are the old ones deleted. So a
 * failed write never deletes anything.
 *
 * The review history (wave 5): a weekly backup carries the review history
 * (`revlog`, the row store's table) like an exported one; only images are left
 * out (spec §8.4 "an envelope (no media)"). WHY: a restore REPLACES
 * everything, the history table too. A weekly backup without the history
 * would quietly empty it ("Restored — 3 decks, 1,240 cards." and every review
 * row gone). The history is read only when a backup is due, so the check on
 * every app start stays cheap. When it cannot be read, NO backup is written
 * and nothing is deleted (a backup without it would push a complete one out
 * of the newest 3); the next check tries again.
 *
 * The two settings, in wave 2: the v2 `AppSettings` type (src/domain/types.ts)
 * has no `autoBackup` / `lastAutoBackupAt` yet; the v3 type (model.ts) has
 * them with the same names and meaning. Until v3, they are extra keys in
 * `state.settings` (unknown keys survive every migrate and reducer step,
 * because those spread objects). `readBackupSettings()` reads them with their
 * defaults, and `backupSettingsPatch()` writes them through
 * `actions.updateAppSettings` (both in backup.ts, re-exported here).
 *
 * Example (what useAutoBackup() does a few seconds after the app opens):
 *   const result = await runAutoBackup({ state, ready, persistError, now: Date.now() }, fullBackupIO(appRevlogStore()));
 *   if (result.kind === 'written') actions.updateAppSettings(backupSettingsPatch({ lastAutoBackupAt: now }));
 */
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';

import type { RevlogRow } from '../domain/model';
import { DAY, type DataState } from '../domain/types';
import { BACKUP_PREFIX } from '../platform/backupFile';
import type { BackupFileInfo, SavedFile } from '../platform/files';
import type { PersistError } from './actions';
import {
  backupSettingsPatch,
  backupText,
  type BackupIO,
  backupTimeOf,
  deviceBackupIO,
  fullBackupIO,
  hasData,
  isFromTheFuture,
  localBackupFileName,
  oldBackupsToDelete,
  readBackupSettings,
  refreshBackupList,
} from './backup';
import { useData } from './DataContext';
import { dataProblemOf } from './problemCopy';
import { appRevlogStore } from './storage';

/** A new automatic backup is due when the newest one is this old (7 days). */
export const AUTO_BACKUP_INTERVAL_MS = 7 * DAY;

/** How many automatic backups are kept. */
export const AUTO_BACKUP_KEEP = 3;

/**
 * How long after the app opens (or comes back to the front) the check waits.
 * Writing a big library takes a moment, so it never competes with the first
 * screen.
 */
export const AUTO_BACKUP_DELAY_MS = 4000;

/* ------------------------------------------------------------- settings */

/*
 * The two backup settings and their readers (`BackupSettings`,
 * `readBackupSettings`, `backupSettingsPatch`) live in backup.ts since wave
 * 5, and are re-exported here for the callers of this file. WHY: this file
 * now imports the storage module (the review history of the weekly backup),
 * and the "Automatic backups" switch (BackupRows.tsx) needs only the two
 * readers — it must not load the storage with them.
 */
export { type BackupSettings, backupSettingsPatch, readBackupSettings } from './backup';

/* ------------------------------------------------------- the pure rules */

/** When an automatic backup was made: the stamp in its name, else the file date. */
export function autoBackupTime(file: BackupFileInfo): number | null {
  return backupTimeOf(file);
}

/**
 * When the newest TRUSTED automatic backup was made, or null when there is
 * none. Files without a known time, and files "from the future" (more than a
 * day ahead: the clock was wrong when they were written), are ignored — else
 * no backup would be made until that future day.
 */
export function newestAutoBackupAt(files: readonly BackupFileInfo[], now: number): number | null {
  let newest: number | null = null;
  for (const file of files) {
    if (!file.name.startsWith(BACKUP_PREFIX.auto)) continue;
    const at = autoBackupTime(file);
    if (at === null || isFromTheFuture(at, now)) continue;
    if (newest === null || at > newest) newest = at;
  }
  return newest;
}

/** True when an automatic backup is due: never made, or the newest is 7 days old or older. */
export function isAutoBackupDue(newestAt: number | null, now: number): boolean {
  return newestAt === null || now - newestAt >= AUTO_BACKUP_INTERVAL_MS;
}

/**
 * The automatic backups to delete so that only the newest `keep` stay.
 * Newest = latest time. A file with an unknown time, or a time "from the
 * future", counts as the OLDEST (so a wrong clock can never keep a stale file
 * and delete the real new ones). Other files (a copy made before a restore,
 * an export) are never touched.
 */
export function autoBackupsToDelete(
  files: readonly BackupFileInfo[],
  now: number,
  keep: number = AUTO_BACKUP_KEEP,
): string[] {
  // The same ranking as the copies made before a restore (src/store/backup.ts).
  return oldBackupsToDelete(files, BACKUP_PREFIX.auto, now, keep);
}

/* --------------------------------------------------------------- runner */

/** What the runner needs to know about the app right now. */
export interface AutoBackupInput {
  state: DataState;
  /** The saved data is loaded. */
  ready: boolean;
  persistError: PersistError;
  now: number;
}

/** Why no backup was written. */
export type AutoBackupSkip = 'not-ready' | 'blocked' | 'off' | 'empty' | 'not-due';

export type AutoBackupResult =
  | { kind: 'skipped'; reason: AutoBackupSkip }
  | { kind: 'written'; file: SavedFile; removed: string[] }
  /**
   * 'list' = the folder could not be read; 'history' = the review history
   * could not be read; 'write' = the new backup could not be written.
   * Nothing was written or deleted.
   */
  | { kind: 'failed'; step: 'list' | 'history' | 'write' };

/**
 * Write an automatic backup when one is due (the five rules of the file
 * comment), then delete all but the newest 3. Never rejects. Old backups
 * that cannot be deleted are simply kept.
 *
 * The backup carries the review history when `io` can read it
 * (`io.readRevlog`, see `fullBackupIO`); it is read only once a backup is
 * due. Async because of that read; every other step is synchronous.
 */
export async function runAutoBackup(input: AutoBackupInput, io: BackupIO = deviceBackupIO): Promise<AutoBackupResult> {
  const { state, now } = input;
  if (!input.ready) return { kind: 'skipped', reason: 'not-ready' };
  if (dataProblemOf(input.persistError) !== null) return { kind: 'skipped', reason: 'blocked' };
  if (!readBackupSettings(state.settings).autoBackup) return { kind: 'skipped', reason: 'off' };
  if (!hasData(state)) return { kind: 'skipped', reason: 'empty' };

  let existing: BackupFileInfo[];
  try {
    existing = io.list(BACKUP_PREFIX.auto);
  } catch {
    return { kind: 'failed', step: 'list' };
  }
  if (!isAutoBackupDue(newestAutoBackupAt(existing, now), now)) {
    return { kind: 'skipped', reason: 'not-due' };
  }

  // The review history, so restoring this backup does not empty it (file comment).
  let revlog: RevlogRow[] | undefined;
  if (io.readRevlog) {
    try {
      revlog = await io.readRevlog();
    } catch {
      return { kind: 'failed', step: 'history' };
    }
  }

  let file: SavedFile;
  try {
    // The review history, but WITHOUT images (spec §8.4: "write an envelope (no media)").
    // Named in LOCAL time ('auto-2026-10-24-09-28-30.json', wave 5b L8).
    file = io.writeDocument(localBackupFileName('auto', now), backupText(state, now, revlog ? { revlog } : undefined));
  } catch {
    return { kind: 'failed', step: 'write' };
  }

  // The new file counts as one of the kept ones. Its name may equal an old
  // one (same second): then it simply replaced it.
  const all = existing.some((f) => f.name === file.name)
    ? existing
    : [...existing, { name: file.name, uri: file.uri, size: 0, modifiedAt: now }];
  const removed: string[] = [];
  for (const name of autoBackupsToDelete(all, now)) {
    try {
      io.remove(name);
      removed.push(name);
    } catch {
      // An old backup that cannot be deleted does no harm; the new one is written.
    }
  }
  refreshBackupList(io);
  return { kind: 'written', file, removed };
}

/* ----------------------------------------------------------------- hook */

/**
 * Runs the automatic backup in the background: a few seconds after the data
 * is loaded, and again each time the app comes back to the front (a phone may
 * keep the app open for weeks). Mounted once, in the tabs layout
 * (src/app/(tabs)/_layout.tsx). After a backup it stores `lastAutoBackupAt`.
 *
 * The disk is `fullBackupIO(appRevlogStore())`: the backups folder plus the
 * review history (images are never read: a weekly backup has none). Only one
 * check runs at a time: while one still reads the history, a new check is
 * skipped (it would write a second backup for the same week).
 */
export function useAutoBackup(): void {
  const { ready, state, persistError, actions } = useData();
  const blocked = dataProblemOf(persistError) !== null;
  const enabled = readBackupSettings(state.settings).autoBackup;

  // The check runs later, from a timer, so it reads the LATEST values from
  // this ref (updated after every render), never a stale copy.
  const latest = useRef({ ready, state, persistError, actions });
  useEffect(() => {
    latest.current = { ready, state, persistError, actions };
  });

  useEffect(() => {
    if (!ready || blocked || !enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // True while a check is running (it waits for the review history).
    let running = false;
    const check = () => {
      timer = null;
      if (running) return;
      running = true;
      const now = Date.now();
      const current = latest.current;
      void runAutoBackup(
        { state: current.state, ready: current.ready, persistError: current.persistError, now },
        fullBackupIO(appRevlogStore()),
      )
        .then((result) => {
          // The file is written: store the date even if the screen closed meanwhile.
          if (result.kind === 'written') {
            latest.current.actions.updateAppSettings(backupSettingsPatch({ lastAutoBackupAt: now }));
          }
        })
        .catch(() => {
          // runAutoBackup never rejects; a failed settings write is tried again after the next backup.
        })
        .finally(() => {
          running = false;
        });
    };
    const schedule = () => {
      if (timer === null) timer = setTimeout(check, AUTO_BACKUP_DELAY_MS);
    };
    schedule();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') schedule();
    });
    return () => {
      sub.remove();
      if (timer !== null) clearTimeout(timer);
    };
  }, [ready, blocked, enabled]);
}
