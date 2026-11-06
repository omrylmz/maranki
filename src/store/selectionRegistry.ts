/**
 * Card selections for the session route, by token (spec §2.2 "Route params
 * rules", §6.7). "Practice the {n} you missed" and "Practice {n} selected"
 * open `/session?kind=practice&sel=<token>`:
 *
 *   const token = putSelection(missedIds);                  // Complete screen
 *   router.push({ pathname: '/session', params: { kind: 'practice', sel: token } });
 *   …
 *   const ids = getSelection(params.sel);                   // session's useState initializer
 *   if (ids === null) → EmptyQueue "This selection is no longer available."
 *
 * WHY a token: card ids are NEVER put in a URL (a long list of ids makes a
 * huge, leaky route). The ids stay in this in-memory map; the URL carries
 * only a short token.
 *
 * The map lives in memory only (nothing is saved). So after an app restart
 * every old token is unknown and `getSelection` returns null — the session
 * then shows "This selection is no longer available." A token also expires
 * after SELECTION_TTL_MS, and only the newest SELECTION_MAX selections are
 * kept (a selection is used right after it is made).
 *
 * The ids of one selection are unique and keep their first order (the miss
 * order of "Practice the {n} you missed").
 */

/** A selection older than this is gone (12 hours). */
export const SELECTION_TTL_MS = 12 * 60 * 60 * 1000;
/** At most this many selections are kept; the oldest goes first. */
export const SELECTION_MAX = 20;
/** Every token starts with this. */
export const SELECTION_TOKEN_PREFIX = 'sel-';

export interface SelectionRegistry {
  /** Keep a list of card ids; returns its token. Repeated ids are kept once, in their first order. */
  put(cardIds: readonly string[]): string;
  /** The ids of a token (a copy), or null when the token is unknown, empty or expired. */
  get(token: string | null | undefined): string[] | null;
  /** Forget one selection. */
  drop(token: string): void;
  /** Forget every selection. */
  clear(): void;
  /** How many selections are kept now (expired ones included until they are read). */
  readonly size: number;
}

export interface SelectionRegistryOptions {
  /** The clock. Default Date.now. */
  now?: () => number;
  /** Default SELECTION_TTL_MS. */
  ttlMs?: number;
  /** Default SELECTION_MAX. */
  max?: number;
}

export function createSelectionRegistry(options: SelectionRegistryOptions = {}): SelectionRegistry {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? SELECTION_TTL_MS;
  const max = Math.max(1, options.max ?? SELECTION_MAX);
  // A Map keeps insertion order, so the first key is the oldest selection.
  const entries = new Map<string, { ids: string[]; at: number }>();
  let counter = 0;

  return {
    put(cardIds) {
      counter += 1;
      const at = now();
      // Time + counter: unique in this run, and never equal to a token of an
      // earlier run (whose time was earlier), so an old link finds nothing.
      const token = `${SELECTION_TOKEN_PREFIX}${at.toString(36)}-${counter.toString(36)}`;
      const ids = [...new Set(cardIds.filter((id) => typeof id === 'string' && id !== ''))];
      entries.set(token, { ids, at });
      while (entries.size > max) entries.delete(entries.keys().next().value as string);
      return token;
    },
    get(token) {
      if (typeof token !== 'string' || token === '') return null;
      const entry = entries.get(token);
      if (!entry) return null;
      if (now() - entry.at > ttlMs) {
        entries.delete(token);
        return null;
      }
      return [...entry.ids];
    },
    drop(token) {
      entries.delete(token);
    },
    clear() {
      entries.clear();
    },
    get size() {
      return entries.size;
    },
  };
}

/** The app's one registry. */
export const selectionRegistry: SelectionRegistry = createSelectionRegistry();

/** Keep card ids for a session route; returns the `sel` token. */
export function putSelection(cardIds: readonly string[]): string {
  return selectionRegistry.put(cardIds);
}

/** The card ids of a `sel` token, or null ("This selection is no longer available."). */
export function getSelection(token: string | null | undefined): string[] | null {
  return selectionRegistry.get(token);
}
