/**
 * The global snackbar/undo channel (WIRING.md: `onSnack(text)` fires from
 * everywhere). One message at a time, optional action (Undo). The host view
 * lives in the root layout so it floats above the tab bar on every screen.
 *
 * How long a message stays (snackDurationMs, walkthrough M5):
 *   - a plain message ("Deck saved"):            2.8 s
 *   - a message with an action ("… · Undo"):     6 s   (at least 5 s, so a late Undo still lands)
 *   - with a screen reader on (TalkBack, VoiceOver), longer: the learner must
 *     hear the message and then find the button:
 *       plain 6 s, with an action 15 s (at least 10 s).
 * A new message replaces the old one and starts its own time. Undo (the
 * action) and dismiss() close it at once.
 *
 * The screen reader state is read from the OS when the provider mounts and
 * kept up to date by the 'screenReaderChanged' event. It is kept in a ref:
 * `show` (an event handler) reads it, rendering never does.
 *
 * useSnackDuration() is that same rule as a hook, for a screen that draws
 * its own snackbar (the study session): an Undo there stays as long.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

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

/** A plain message, no screen reader. */
export const SNACK_PLAIN_MS = 2800;
/** A message with an action (Undo), no screen reader: at least 5 s. */
export const SNACK_ACTION_MS = 6000;
/** A plain message while a screen reader is on. */
export const SNACK_PLAIN_SCREEN_READER_MS = 6000;
/** A message with an action while a screen reader is on: at least 10 s. */
export const SNACK_ACTION_SCREEN_READER_MS = 15000;

/**
 * How long a message stays on screen, in ms (see the file header).
 *
 *   snackDurationMs({ hasAction: true,  screenReader: false }) → 6000
 *   snackDurationMs({ hasAction: true,  screenReader: true })  → 15000
 *   snackDurationMs({ hasAction: false, screenReader: false }) → 2800
 */
export function snackDurationMs({ hasAction, screenReader }: { hasAction: boolean; screenReader: boolean }): number {
  if (screenReader) return hasAction ? SNACK_ACTION_SCREEN_READER_MS : SNACK_PLAIN_SCREEN_READER_MS;
  return hasAction ? SNACK_ACTION_MS : SNACK_PLAIN_MS;
}

/**
 * Follow the OS screen reader setting: `onChange` gets the first answer and
 * every change. Returns the stop function. A platform without the API (an
 * old web build) simply never calls `onChange` (the screen reader counts as
 * off).
 */
function watchScreenReader(onChange: (on: boolean) => void): () => void {
  let alive = true;
  let subscription: { remove(): void } | null = null;
  try {
    AccessibilityInfo.isScreenReaderEnabled()
      .then((on) => {
        if (alive) onChange(on === true);
      })
      .catch(() => undefined);
  } catch {
    // No such method here: the screen reader stays "off".
  }
  try {
    subscription =
      AccessibilityInfo.addEventListener('screenReaderChanged', (on: boolean) => {
        if (alive) onChange(on === true);
      }) ?? null;
  } catch {
    subscription = null;
  }
  return () => {
    alive = false;
    subscription?.remove();
  };
}

/**
 * How long a message stays (snackDurationMs), with the screen reader state
 * followed from the OS. For the global channel below, and for a screen that
 * draws its OWN snackbar (the study session's "Good · Undo"), so both keep
 * an Undo for the same time. Returns a function that never changes; call it
 * when the message appears (in an event handler or an effect, never while
 * rendering: it reads a ref).
 *
 *   const durationFor = useSnackDuration();
 *   useEffect(() => {
 *     if (!snack) return;
 *     const t = setTimeout(() => setSnack(null), durationFor(!!snack.undo));
 *     return () => clearTimeout(t);
 *   }, [snack, durationFor]);
 */
export function useSnackDuration(): (hasAction: boolean) => number {
  /** True while a screen reader is on (written by the OS callback, read when a message appears). */
  const screenReader = useRef(false);

  // Only a subscription here: the ref is written later, from the OS callback.
  useEffect(
    () =>
      watchScreenReader((on) => {
        screenReader.current = on;
      }),
    [],
  );

  return useCallback((hasAction: boolean) => snackDurationMs({ hasAction, screenReader: screenReader.current }), []);
}

export function SnackbarProvider({ children }: { children: React.ReactNode }) {
  const [snack, setSnack] = useState<SnackMessage | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const durationFor = useSnackDuration();

  // No timer may fire after the provider is gone.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    },
    [],
  );

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
      timer.current = setTimeout(() => {
        timer.current = null;
        setSnack(null);
      }, durationFor(!!action));
    },
    [durationFor],
  );

  const value = useMemo(() => ({ snack, show, dismiss }), [snack, show, dismiss]);
  return <SnackbarContext.Provider value={value}>{children}</SnackbarContext.Provider>;
}

export function useSnackbar(): SnackbarValue {
  const ctx = useContext(SnackbarContext);
  if (!ctx) throw new Error('useSnackbar must be used inside SnackbarProvider');
  return ctx;
}
