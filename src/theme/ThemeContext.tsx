/**
 * Theme runtime: the RN equivalent of flipping `data-theme="dark"` on the
 * mockup's wrapper. Two layers, mirroring app.jsx:
 *  - `mode` — the persisted Settings choice: 'light' | 'dark' | 'system'
 *  - `override` — the Home moon-toggle's session-only override (not persisted)
 * Resolution: override ?? (mode === 'system' ? OS scheme : mode).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useColorScheme } from 'react-native';

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
}

const STORAGE_KEY = 'maranki.themeMode';

const ThemeContext = createContext<ThemeValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const systemScheme = useColorScheme();
  const [mode, setModeState] = useState<ThemeMode>('light');
  const [override, setOverride] = useState<ResolvedScheme | null>(null);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((stored) => {
        if (stored === 'light' || stored === 'dark' || stored === 'system') {
          setModeState(stored);
        }
      })
      .catch(() => {
        // A failed preference read just keeps the default — never an unhandled
        // rejection.
      });
  }, []);

  const setMode = useCallback((next: ThemeMode) => {
    setOverride(null); // an explicit Settings choice clears the moon toggle
    setModeState(next);
    AsyncStorage.setItem(STORAGE_KEY, next).catch(() => {});
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
    }),
    [mode, setMode, override, resolved],
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
