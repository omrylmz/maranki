/**
 * Pure persistence helpers for the data store.
 *
 * Extracted from DataContext so the load DECISION is side-effect-free and
 * unit-testable. The old inline effect conflated three very different cases
 * into one silent "seed and overwrite" path:
 *   - no stored data (genuine first boot)
 *   - a stored document that is present but UNPARSEABLE (e.g. a write truncated
 *     by an OS kill) — must be preserved, not silently discarded
 *   - a READ FAILURE (getItem rejected) — must NOT trigger a seed, or the
 *     debounced save clobbers the user's still-intact data (the audit's C1)
 *
 * A read *failure* cannot be represented as a value here (it is a rejected
 * promise); the caller handles it separately. This module only classifies a
 * value that was successfully read.
 */
import { DataState } from '../domain/types';

/** Live document key. Bump only behind a migration. */
export const STORAGE_KEY = 'maranki.state.v1';
/** Where an unparseable blob is copied before re-seeding, for manual recovery. */
export const BACKUP_KEY = 'maranki.state.v1.corrupt';

export type LoadOutcome =
  | { kind: 'first-boot' }
  | { kind: 'loaded'; state: DataState }
  | { kind: 'corrupt'; raw: string };

/**
 * The minimum structural shape the running app relies on. Deliberately shallow
 * (not a deep schema check): a document carrying the core collections + person
 * + settings is safe to adopt.
 */
export function isValidState(value: unknown): value is DataState {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Partial<DataState>;
  return (
    Array.isArray(s.cards) &&
    Array.isArray(s.decks) &&
    typeof s.person === 'object' &&
    s.person !== null &&
    typeof s.settings === 'object' &&
    s.settings !== null
  );
}

/** Parse a stored document, or null when absent / empty / unparseable / invalid. */
export function parseStored(raw: string | null): DataState | null {
  if (raw == null || raw === '') return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isValidState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Classify a RESOLVED getItem value. A rejected getItem is the caller's
 * responsibility (it must block writes), so a transient read error never
 * overwrites intact stored data with a seed.
 */
export function classifyStored(raw: string | null): LoadOutcome {
  if (raw == null || raw === '') return { kind: 'first-boot' };
  const state = parseStored(raw);
  return state ? { kind: 'loaded', state } : { kind: 'corrupt', raw };
}

export function serialize(state: DataState): string {
  return JSON.stringify(state);
}

/**
 * User-facing message for a persistence failure, or null when there is none.
 * Surfaced via the snackbar (M15) so a failed load/save is never silent:
 *   - 'read'  — saved data couldn't be opened; writes are blocked so the intact
 *               document is never overwritten (C1) — a restart is the safe move.
 *   - 'write' — the latest changes didn't persist (e.g. device storage full).
 */
export function persistErrorMessage(kind: 'read' | 'write' | null): string | null {
  if (kind === 'read')
    return "Couldn't open your saved data — please restart. Your progress is safe and won't be overwritten.";
  if (kind === 'write') return "Couldn't save your latest changes — your device may be out of storage.";
  return null;
}
