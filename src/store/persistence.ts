/**
 * Small persistence helpers that several modules share: the old AsyncStorage
 * key names, `serialize`, `isValidState`, `persistErrorMessage` (the M15
 * snackbar texts) and `decideLoad` (a dry run of the load decision).
 *
 * WHERE THE LOAD RULES LIVE (since W2-1): the app boots ONLY through the
 * engine (engine.ts) and the PersistController (persistController.ts), over a
 * StoragePort (storage/*). Each data-safety rule of the load is there, once:
 *   - C1: a read that fails blocks every write    → persistController.ts load()
 *   - a corrupt text is copied before the seed    → persistController.ts + the port
 *   - too-new / a throwing migrate() block writes → persistController.ts judgeDocument()
 *   - an older schema is copied once (premigrate) → engine.ts decode
 * The wave-1 boot path (`bootLoad`, `BootIO`) kept a second copy of these
 * rules. Nothing in the app used it after W2-1, so it was deleted.
 */
import { CURRENT_SCHEMA, type DataState } from '../domain/types';
import type { PersistError } from './actions';
import { isValidState, migrate, type MigrateOutcome } from './migrate';
import { judgeDocument, type BlockReason } from './persistController';

export { isValidState };
/** Why every write is blocked. Defined ONCE, in persistController.ts. */
export type { BlockReason };

/**
 * The AsyncStorage key of the live document up to wave 1. From wave 2 the
 * live document is in the kv-store (`maranki.state`, storage/kvStoragePort.ts);
 * this key is only READ, once, by the copy-forward (storage/copyForward.ts)
 * and the Android RKStorage rescue (storage/rkRescue.ts), and the old copy
 * stays for 2 releases (spec §3.1 rule 3).
 * The schema version lives INSIDE the document (`schemaVersion`).
 */
export const STORAGE_KEY = 'maranki.state.v1';
/**
 * Where the AsyncStorage port (storage/asyncStoragePort.ts) copies an
 * unparseable text. The app does not use that port since W2-1: the kv port
 * keeps its corrupt copies under `maranki.state.corrupt.{stamp}`.
 */
export const BACKUP_KEY = 'maranki.state.v1.corrupt';

/**
 * What a stored text means (the result of `decideLoad`).
 *   - first-boot — nothing stored: start from the seed;
 *   - loaded     — a readable document, migrated to today's schema. `from` is
 *                  the version it had; `repaired` lists every repair;
 *   - corrupt    — stored, but not a Maranki document (truncated JSON, wrong
 *                  shape). The app keeps `raw` somewhere safe, then uses the seed;
 *   - blocked    — readable JSON that we must not use or overwrite:
 *                  'too-new' (a newer app saved it) or 'migrate' (migrate()
 *                  threw — a bug, never a reason to call the data corrupt).
 */
export type LoadOutcome =
  | { kind: 'first-boot' }
  | { kind: 'loaded'; state: DataState; from: number; repaired: string[] }
  | { kind: 'corrupt'; raw: string }
  | { kind: 'blocked'; reason: BlockReason };

/** The migrate step `decideLoad` runs. Injected only by tests (to make it throw). */
export type MigrateFn = (doc: unknown, now: number) => MigrateOutcome;

/**
 * A DRY RUN of the app's load decision for a stored text that was read
 * successfully. Pure: it copies nothing and writes nothing. The app itself
 * does not call it (the PersistController does the real load); tests and
 * test helpers use it to ask "would this text load?".
 *
 * It holds NO rule of its own: the parse step is the one every port's
 * `load()` does (`classifyRaw` in storage/kvStoragePort.ts), and the document
 * step IS the controller's `judgeDocument`, with migrate() as `decode`. A read
 * FAILURE is not a value here (it is a rejected promise; the controller then
 * blocks every write: C1).
 *
 * Example: `decideLoad(serialize(state), Date.now()).kind === 'loaded'`.
 */
export function decideLoad(raw: string | null, now: number, migrateFn: MigrateFn = migrate): LoadOutcome {
  // The port's parse step: nothing stored → first boot; not JSON → corrupt.
  if (raw == null || raw === '') return { kind: 'first-boot' };
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return { kind: 'corrupt', raw };
  }
  // The controller's document step (the same function load() runs).
  const verdict = judgeDocument<DataState>((value, ctx) => migrateFn(value, ctx.now), doc, { raw, now });
  if (verdict.kind === 'blocked') return { kind: 'blocked', reason: verdict.reason };
  if (verdict.kind === 'corrupt') return { kind: 'corrupt', raw };
  const { state, from, repaired } = verdict.decoded;
  // migrate() always sets `from` and `repaired`; the fallbacks only satisfy the wider DecodeResult type.
  return { kind: 'loaded', state, from: from ?? CURRENT_SCHEMA, repaired: [...(repaired ?? [])] };
}

/**
 * The old name of `decideLoad`, with the clock read here.
 * @deprecated Use `decideLoad(raw, now)`. Only tests call it; it goes in W5-3.
 */
export function classifyStored(raw: string | null): LoadOutcome {
  return decideLoad(raw, Date.now());
}

/**
 * Parse AND migrate a stored document; null when absent, unreadable, too new or invalid.
 * @deprecated Use `decideLoad(raw, now)`. Only tests call it; it goes in W5-3.
 */
export function parseStored(raw: string | null): DataState | null {
  const outcome = decideLoad(raw, Date.now());
  return outcome.kind === 'loaded' ? outcome.state : null;
}

export function serialize(state: DataState): string {
  return JSON.stringify(state);
}

/* ----------------------------------------------------------------- errors */

/**
 * User-facing message for a persistence failure, or null when there is none.
 * Surfaced via the snackbar (M15) so a failed load/save is never silent:
 *   - 'read'    — saved data couldn't be opened; writes are blocked so the
 *                 intact document is never overwritten (C1) — a restart is the
 *                 safe move.
 *   - 'too-new' — a newer Maranki saved the data; writes are blocked until the
 *                 app is updated (spec §3.1 rule 6).
 *   - 'migrate' — the data couldn't be updated to this version; writes are
 *                 blocked (spec §3.1 rule 7).
 *   - 'write'   — the latest changes didn't persist (e.g. device storage full).
 * The full-screen texts of the data-problem screen live in problemCopy.ts (W1-4).
 */
export function persistErrorMessage(kind: PersistError): string | null {
  if (kind === 'read')
    return "Couldn't open your saved data — please restart. Your progress is safe and won't be overwritten.";
  if (kind === 'too-new')
    return 'This data was saved by a newer version of Maranki. Please update the app. Nothing was changed.';
  if (kind === 'migrate') return "We couldn't update your data to this version. Nothing was changed.";
  if (kind === 'write') return "Couldn't save your latest changes — your device may be out of storage.";
  return null;
}
