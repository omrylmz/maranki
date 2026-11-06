/**
 * Share a file with another app — the system share sheet ("Save to Files",
 * Drive, mail …), via expo-sharing (spec §8.4, §8.8).
 *
 * WHY: a file in the app's own folders is private. The user cannot see it, and
 * it is deleted with the app. Only the share sheet puts a backup somewhere the
 * user can keep (the old "Export a backup" wrote a private file that nobody
 * could open or restore — audit M1).
 *
 * `shareFile` first asks `Sharing.isAvailableAsync()`. When sharing is not
 * available (the web preview, some restricted devices), it shares nothing and
 * resolves `false`; the caller then keeps the file in Paths.document/backups/
 * and shows its name (spec §8.4). When the share sheet opens it resolves
 * `true`. An error of the share sheet itself rejects.
 *
 * Example (the name is in the phone's LOCAL time: src/store/backup.ts
 * `localBackupFileName`; never a UTC stamp, wave 5d L8):
 *   const text = encodeBackup(state, meta);
 *   const file = writeCacheFile(localBackupFileName('export', now), text);
 *   if (!(await shareFile(file.uri, SHARE_BACKUP))) {
 *     show(`Saved as ${writeDocumentFile(file.name, text).name}`);
 *   }
 */
import * as Sharing from 'expo-sharing';

/** How a file is described to the share sheet. */
export interface ShareKind {
  /** Android: the MIME type of the share Intent, e.g. 'application/json'. */
  mimeType: string;
  /** iOS: the Uniform Type Identifier, e.g. 'public.json'. */
  UTI: string;
  /** Android and web: the share sheet title. */
  dialogTitle: string;
}

/** A Maranki backup file (spec §8.4, exact title). */
export const SHARE_BACKUP: ShareKind = {
  mimeType: 'application/json',
  UTI: 'public.json',
  dialogTitle: 'Save your Maranki backup',
};

/** The sessions history CSV (spec §8.8, wave 2). */
export const SHARE_HISTORY_CSV: ShareKind = {
  mimeType: 'text/csv',
  UTI: 'public.comma-separated-values-text',
  dialogTitle: 'Export study history',
};

/** The history zip: sessions CSV + review CSV (spec §8.8, wave 3). */
export const SHARE_HISTORY_ZIP: ShareKind = {
  mimeType: 'application/zip',
  UTI: 'public.zip-archive',
  dialogTitle: 'Export study history',
};

/**
 * Open the share sheet for the local file at `uri` (a file:// URI, for example
 * `File.uri`). Resolves false, without sharing, when sharing is not available.
 */
export async function shareFile(uri: string, kind: ShareKind): Promise<boolean> {
  if (!(await Sharing.isAvailableAsync())) return false;
  await Sharing.shareAsync(uri, { mimeType: kind.mimeType, dialogTitle: kind.dialogTitle, UTI: kind.UTI });
  return true;
}
