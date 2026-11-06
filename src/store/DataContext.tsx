/**
 * The data provider — a THIN React shell around the engine (spec §3.9, W2-1,
 * W3-2).
 *
 * Every rule lives outside React, in tested plain TypeScript:
 *   - engine.ts            — boot, the M5 reconcile, every action;
 *   - reducer.ts           — every state change, as a pure command on the v3
 *                            note model (spec §3.6 `Actions` + the temporary
 *                            aliases, see actions.ts);
 *   - persistController.ts — when the state may be read and saved (C1, M15, M16);
 *   - storage/index.ts     — WHERE it is saved: the row store `maranki-rows.db`
 *                            on a phone (copied forward once from the older
 *                            storage, W3-3), memory on the web preview;
 *   - platform/media.ts    — the deck image folders that deleteDeck and
 *                            duplicateDeck change (engine.ts `DeckMedia`).
 *
 * This file only:
 *   1. makes one engine per provider (`useState(() => createEngine(...))`);
 *   2. boots it in an effect (after the previous provider's last save), and
 *      counts a boot that was not blocked (`markAppBootOk`, spec §3.10 step 6);
 *   3. saves at once when the app goes to the background (M16), and on unmount;
 *   4. gives screens `useData()` — the SAME shape as before W2-1:
 *      `{ ready, state, lastCompletion, persistError, actions }`
 *      (`actions` = actions.ts `DataActions`);
 *   5. throws a boot error (a bug in the boot reconcile) during render, so the
 *      root ErrorBoundary shows the crash screen (with "Save a copy").
 *
 * The effect may run setup → cleanup → setup on the SAME provider: React's
 * StrictMode does it, and Fast Refresh does it in development after every
 * edit. useState keeps the same engine, and the cleanup disposed it, so the
 * setup first calls `engine.resume()`. Without it, every change after an edit
 * would silently never be saved.
 */
import React, { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { AppState, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { DataState } from '@/domain/types';
import { font } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

import { deleteDeckMedia, mergeDeckMedia, moveImageNames } from '../platform/media';
import type { CompletionPayout, PersistError } from './actions';
import { createEngine, type DeckMedia, type EngineActions } from './engine';
import { EngineContext, useEngine, useEngineMeta } from './selectors';
import { appStoragePort, isMemoryOnlyStorage, markAppBootOk, WEB_PREVIEW_NOTICE } from './storage';

// The one copy of these helpers lives in reducer.ts / selectors.ts. They are
// re-exported here because the screens import them from this file.
export { normalizedDayDone } from './reducer';
export { useAchievements } from './selectors';

interface DataValue {
  /** True once the saved data was loaded (or the load ended blocked). */
  ready: boolean;
  state: DataState;
  /** The payout of the session just completed (the Complete screen). */
  lastCompletion: CompletionPayout | null;
  /**
   * The full PersistError contract (src/store/actions.ts). The boot sets
   * 'read' (C1), 'too-new' or 'migrate' — each one blocks every write; a failed
   * save sets 'write' (M15).
   */
  persistError: PersistError;
  actions: EngineActions;
}

const DataContext = createContext<DataValue | null>(null);

/**
 * The last save of the provider that unmounted before this one (for example
 * "Try again", or the crash screen's retry). A new provider boots only after
 * it is on the disk, so it never reads the data one save too early. (Its
 * FlushResult does not matter here: flush() never rejects, so the boot always
 * runs, also after a failed save.)
 */
let previousProviderSave: Promise<unknown> = Promise.resolve();

/**
 * The deck image folders on the phone (src/platform/media.ts), in the shape
 * the engine needs (engine.ts `DeckMedia`). `mergeDeckMedia` copies only
 * `names` when it gets them (Move to deck…), never overwrites a file, and
 * throws when a copy is not complete: the engine then keeps the old folder.
 * `moveImageNames` gives a moved picture a name of its own when the new
 * deck has another picture under its name (the engine rewrites the notes).
 */
const DECK_MEDIA: DeckMedia = {
  removeDeckFolder: (deckId) => {
    deleteDeckMedia(deckId);
  },
  copyDeckFolder: (fromDeckId, toDeckId, names, renamed) => mergeDeckMedia(fromDeckId, toDeckId, names, renamed),
  imageNames: (fromDeckId, toDeckId, names) => moveImageNames(fromDeckId, toDeckId, names),
};

export function DataProvider({ children }: { children: React.ReactNode }) {
  const [engine] = useState(() => createEngine(appStoragePort(), { media: DECK_MEDIA }));
  // A boot that failed with a bug. Wrapped, because JavaScript can throw anything (even undefined).
  const [bootError, setBootError] = useState<{ error: unknown } | null>(null);

  useEffect(() => {
    // A second setup on the same engine (see the file comment): save again.
    engine.resume();
    let active = true;
    void previousProviderSave
      .then(() => engine.boot())
      .then((result) => {
        // Spec §3.10 step 6: count a boot that reached "ready" (meta.bootOkCount).
        // It never rejects, and a second call for the same boot does nothing.
        if (result.kind !== 'blocked') void markAppBootOk();
      })
      .catch((error: unknown) => {
        // After this effect's cleanup, a rejection only means "the engine
        // was disposed": this provider is gone. Every other one is a bug.
        if (active) setBootError({ error });
      });

    // M16: save the last <= 400 ms of changes (e.g. a session just finished)
    // before the OS may suspend or kill the app.
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'background' || next === 'inactive') void engine.flush();
    });
    return () => {
      active = false;
      sub.remove();
      // flush() queues the last save; dispose() then stops new writes. The
      // queued save still reaches the disk (persistController.ts).
      previousProviderSave = engine.flush();
      engine.dispose();
    };
  }, [engine]);

  // The root ErrorBoundary (src/app/_layout.tsx) catches it and shows ErrorScreen.
  if (bootError) throw bootError.error;

  return (
    <EngineContext.Provider value={engine}>
      <DataValueProvider actions={engine.actions}>{children}</DataValueProvider>
      {isMemoryOnlyStorage() ? <WebPreviewBanner /> : null}
    </EngineContext.Provider>
  );
}

/** Builds the useData() value from the engine's two stores. */
function DataValueProvider({ actions, children }: { actions: EngineActions; children: React.ReactNode }) {
  const store = useEngine().store;
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const { ready, lastCompletion, persistError } = useEngineMeta();

  const value = useMemo<DataValue>(
    () => ({ ready, state, lastCompletion, persistError, actions }),
    [ready, state, lastCompletion, persistError, actions],
  );
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useData(): DataValue {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error('useData must be used inside DataProvider');
  return ctx;
}

/**
 * The quiet notice of the web preview (spec §3.7, decision D6): on the web the
 * state lives only in memory, so nothing is saved. It never takes a touch.
 *
 * `pointerEvents` is a STYLE key, not a prop: react-native-web 0.21 logs a
 * deprecation warning for the prop on every web preview session, and React
 * Native 0.85 supports the style key. Exported for its test only.
 */
export function WebPreviewBanner() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={{
        position: 'absolute',
        top: insets.top + 4,
        left: 0,
        right: 0,
        alignItems: 'center',
        pointerEvents: 'none',
      }}
    >
      <Text
        accessibilityRole="text"
        style={[
          font('sans', 600),
          {
            fontSize: 11.5,
            color: c.ink2,
            backgroundColor: c.surface,
            borderColor: c.hairline,
            borderWidth: 1,
            borderRadius: 999,
            paddingHorizontal: 10,
            paddingVertical: 3,
            overflow: 'hidden',
          },
        ]}
      >
        {WEB_PREVIEW_NOTICE}
      </Text>
    </View>
  );
}
