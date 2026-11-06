/**
 * Theme runtime: the RN equivalent of flipping `data-theme="dark"` on the
 * mockup's wrapper. Two layers, mirroring app.jsx:
 *  - `mode` — the persisted Settings choice: 'light' | 'dark' | 'system'
 *  - `override` — the Home moon-toggle's session-only override (not persisted)
 * Resolution: override ?? (mode === 'system' ? OS scheme : mode).
 *
 * Where `mode` is saved (spec §3.7, W2-1): the kv-store file `maranki-kv.db`,
 * key `maranki.themeMode` — the same file as the app data (one connection,
 * `getKvStore()`). It is read with `getItemSync`, so the very first frame
 * already has the right palette: no wait, no light flash before a dark
 * preference (L21).
 *
 * Older builds kept it in AsyncStorage under the same key. The first run of
 * this build copies it into the kv-store ONCE (`themeFromOldStorage`); only
 * that one run waits for the async AsyncStorage read before `hydrated`.
 * The old AsyncStorage key is only read, never deleted.
 *
 * Every theme WRITE waits for `afterAppStorageLoad()` (W2 hardening): on that
 * same first run, the data's copy-forward writes the kv file in an exclusive
 * transaction on a second connection. A theme write at the same moment could
 * make that transaction fail with "database is locked", and the user would
 * see "We couldn't open your saved data." on the first launch. The writes run
 * one after another (`writeThemeMode`), so the last choice always wins.
 *
 * Web preview (D6): nothing is saved, so the mode lives in memory only.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Platform, useColorScheme } from 'react-native';

import { afterAppStorageLoad } from '@/store/storage';
import { getKvStore } from '@/store/storage/kvStoragePort';

import { dark, light, Palette } from './tokens';

export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedScheme = 'light' | 'dark';

interface ThemeValue {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  /** Session-only override from the Home moon toggle. */
  override: ResolvedScheme | null;
  setOverride: (scheme: ResolvedScheme | null) => void;
  resolved: ResolvedScheme;
  colors: Palette;
  /** True once the persisted theme preference has been read (or failed to). */
  hydrated: boolean;
}

/** The key of the theme choice: in the kv-store now, in AsyncStorage in older builds. */
export const THEME_KEY = 'maranki.themeMode';

/** The default when nothing was ever chosen. */
const DEFAULT_MODE: ThemeMode = 'light';

const isThemeMode = (value: unknown): value is ThemeMode =>
  value === 'light' || value === 'dark' || value === 'system';

/** Nothing is saved on the web preview (D6), so it never opens the kv file. */
const SAVES_THEME = Platform.OS !== 'web';

/**
 * The saved mode, read synchronously from the kv-store. `copied: false` means
 * the kv-store has no theme yet: the old AsyncStorage key must be copied once.
 * A failed read keeps the default and does not try to copy (it is not "empty").
 */
function readSavedMode(): { mode: ThemeMode; copied: boolean } {
  if (!SAVES_THEME) return { mode: DEFAULT_MODE, copied: true };
  try {
    const stored = getKvStore().getItemSync(THEME_KEY);
    if (stored === null) return { mode: DEFAULT_MODE, copied: false };
    return { mode: isThemeMode(stored) ? stored : DEFAULT_MODE, copied: true };
  } catch {
    return { mode: DEFAULT_MODE, copied: true };
  }
}

/** The theme writes, one after another (see writeThemeMode). Never rejects. */
let themeWrites: Promise<void> = Promise.resolve();

/**
 * Write `mode` to the kv-store, AFTER the app port's first load
 * (`afterAppStorageLoad`, see the file comment) and after every earlier theme
 * write. Resolves when it is written, or when the write failed: a failed
 * write keeps the choice for this run only (the next run reads the older
 * value, or copies the old key again). Never rejects.
 */
function writeThemeMode(mode: ThemeMode): Promise<void> {
  const write = themeWrites.then(async () => {
    await afterAppStorageLoad();
    await getKvStore().setItem(THEME_KEY, mode);
  });
  themeWrites = write.catch(() => {
    // Not saved: the mode is still used now (see above).
  });
  return themeWrites;
}

/**
 * Copy the old AsyncStorage choice into the kv-store, once. When the old key
 * is empty, the default is written, so the next run does not look again.
 * Resolves the mode to use AT ONCE: the copy is written in the background,
 * after the data's first load (writeThemeMode), so the first frame never
 * waits for the data. A failed old read keeps the default and writes nothing
 * (the next run tries again).
 */
async function themeFromOldStorage(): Promise<ThemeMode> {
  const old = await AsyncStorage.getItem(THEME_KEY);
  const mode = isThemeMode(old) ? old : DEFAULT_MODE;
  void writeThemeMode(mode);
  return mode;
}

/** Save the choice in the kv-store (native only). A failed write keeps the choice for this run. */
function saveMode(mode: ThemeMode): void {
  if (!SAVES_THEME) return;
  void writeThemeMode(mode);
}

const ThemeContext = createContext<ThemeValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const systemScheme = useColorScheme();
  // One synchronous read on the first render (lazy initial state).
  const [saved] = useState(readSavedMode);
  const [mode, setModeState] = useState<ThemeMode>(saved.mode);
  const [override, setOverride] = useState<ResolvedScheme | null>(null);
  const [hydrated, setHydrated] = useState(saved.copied);

  useEffect(() => {
    if (saved.copied) return;
    let cancelled = false;
    themeFromOldStorage()
      .then((old) => {
        if (!cancelled) setModeState(old);
      })
      .catch(() => {
        // A failed old read just keeps the default — never an unhandled rejection.
      })
      // Mark hydrated either way, so the splash waits for the real theme (L21).
      .finally(() => {
        if (!cancelled) setHydrated(true);
      });
    return () => {
      cancelled = true;
    };
  }, [saved]);

  const setMode = useCallback((next: ThemeMode) => {
    setOverride(null); // an explicit Settings choice clears the moon toggle
    setModeState(next);
    saveMode(next);
  }, []);

  const resolved: ResolvedScheme =
    override ?? (mode === 'system' ? (systemScheme === 'dark' ? 'dark' : 'light') : mode);

  const value = useMemo<ThemeValue>(
    () => ({
      mode,
      setMode,
      override,
      setOverride,
      resolved,
      colors: resolved === 'dark' ? dark : light,
      hydrated,
    }),
    [mode, setMode, override, resolved, hydrated],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside ThemeProvider');
  return ctx;
}

export function useColors(): Palette {
  return useTheme().colors;
}
