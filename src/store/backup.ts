/**
 * Backup export. The old "Export a backup" / "Export a backup first" controls
 * showed a success toast but wrote nothing — a false sense of safety shown
 * right before the irreversible factory reset (audit M1). This performs the
 * real write and lets callers report the true outcome.
 *
 * Not imported by any test (it pulls in the native expo-file-system module);
 * the serialization it relies on lives in the pure, tested persistence module.
 */
import { File, Paths } from 'expo-file-system';

import { DataState } from '../domain/types';
import { serialize } from './persistence';

export interface BackupResult {
  /** File name, e.g. "maranki-backup-2026-06-30-21-04-07.json". */
  name: string;
  /** file:// URI of the written backup. */
  uri: string;
}

/** A filesystem-safe timestamp for the backup file name. */
export function backupStamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace(/[:T]/g, '-');
}

/**
 * Write a full-state JSON backup into the document directory. Synchronous (the
 * SDK 56 File API writes synchronously); throws on failure so callers surface a
 * real error instead of a phantom success.
 */
export function exportBackup(state: DataState, stamp: string): BackupResult {
  const name = `maranki-backup-${stamp}.json`;
  const file = new File(Paths.document, name);
  file.create({ overwrite: true });
  file.write(serialize(state));
  return { name, uri: file.uri };
}
