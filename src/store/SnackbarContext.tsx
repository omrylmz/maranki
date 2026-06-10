/**
 * The global snackbar/undo channel (WIRING.md: `onSnack(text)` fires from
 * everywhere). One message at a time, auto-dismisses after 2.8s, optional
 * action (Undo). The host view lives in the root layout so it floats above
 * the tab bar on every screen.
 */
import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

export interface SnackMessage {
  text: string;
  actionLabel?: string;
  onAction?: () => void;
}

interface SnackbarValue {
  snack: SnackMessage | null;
  show: (text: string, action?: { label?: string; onAction: () => void }) => void;
  dismiss: () => void;
}

const SnackbarContext = createContext<SnackbarValue | null>(null);

const AUTO_DISMISS_MS = 2800;

export function SnackbarProvider({ children }: { children: React.ReactNode }) {
  const [snack, setSnack] = useState<SnackMessage | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dismiss = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setSnack(null);
  }, []);

  const show = useCallback(
    (text: string, action?: { label?: string; onAction: () => void }) => {
      if (timer.current) clearTimeout(timer.current);
      setSnack({
        text,
        actionLabel: action ? (action.label ?? 'Undo') : undefined,
        onAction: action?.onAction,
      });
      timer.current = setTimeout(() => setSnack(null), AUTO_DISMISS_MS);
    },
    [],
  );

  const value = useMemo(() => ({ snack, show, dismiss }), [snack, show, dismiss]);
  return <SnackbarContext.Provider value={value}>{children}</SnackbarContext.Provider>;
}

export function useSnackbar(): SnackbarValue {
  const ctx = useContext(SnackbarContext);
  if (!ctx) throw new Error('useSnackbar must be used inside SnackbarProvider');
  return ctx;
}
