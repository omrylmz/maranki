/**
 * Root layout — providers, fonts, and the app's Stack (spec §2.2, W4-5):
 * the 4 tabs, the pushed pages (the deck page `/deck/[id]`, `/help`) and the
 * full-screen modals (session, complete, editors, import, triage,
 * onboarding), the global snackbar, and theme resolution (paper ⇆ evening).
 *
 * Two safety screens (spec W1-4) — the app never shows a white screen:
 *   - `ErrorBoundary` (below): a crash anywhere in the app → ErrorScreen.
 *   - DataProblemScreen: when the saved data could not be opened (persistError
 *     'read' / 'too-new' / 'migrate', so every write is blocked — C1), it is
 *     rendered INSTEAD of the Stack. Its "Try again" remounts the DataProvider
 *     (a new `key`), which loads the saved data again.
 *
 * Daily reminders (spec §8.7):
 *   - `setNotificationHandler` (below, at module load): a reminder that
 *     arrives while the app is open is shown as a banner and in the list,
 *     without sound or badge;
 *   - a TAP on a reminder opens Today: `addNotificationResponseReceivedListener`
 *     for a tap while the app runs, and `useLastNotificationResponse` for the
 *     tap that STARTED the app (cold start). One tap opens Today once
 *     (`reminderTapKey`), and the handled response is cleared;
 *   - `useReminderSync()` plans the reminders again at boot, on every
 *     settings or study-day change (a session complete) and when the app goes
 *     to the background (src/store/reminderSync.ts).
 * Web (the dev preview) has no local notifications: none of this runs there.
 *
 * Android's hardware Back with the keyboard open (final device pass K1-1):
 * `installKeyboardBackGuard` (below, at module load) makes the FIRST Back
 * press close only the keyboard, on every screen. On Android the keyboard
 * can close itself on that press before the app hears it, and the same
 * press then also left the screen (Library search → Today, the card editor
 * → "Discard changes?"). The guard wraps BackHandler.addEventListener, so
 * every Back listener added later — the navigator's own one (expo-router
 * adds it in an effect, AFTER this file is loaded) and the screens' ones —
 * asks it first. It also wraps Keyboard.dismiss, so a close the app asks
 * for (the Settings search opening a result) never takes the next Back
 * press. The rules and the reasons: src/platform/keyboardBack.ts.
 * iOS has no hardware Back: nothing is installed there.
 */
import {
  HankenGrotesk_400Regular,
  HankenGrotesk_500Medium,
  HankenGrotesk_600SemiBold,
  HankenGrotesk_700Bold,
  HankenGrotesk_800ExtraBold,
} from '@expo-google-fonts/hanken-grotesk';
import {
  Newsreader_400Regular,
  Newsreader_400Regular_Italic,
  Newsreader_500Medium,
  Newsreader_500Medium_Italic,
  Newsreader_600SemiBold,
  Newsreader_600SemiBold_Italic,
  Newsreader_700Bold,
} from '@expo-google-fonts/newsreader';
import {
  SplineSansMono_400Regular,
  SplineSansMono_500Medium,
  SplineSansMono_600SemiBold,
} from '@expo-google-fonts/spline-sans-mono';
import { useFonts } from 'expo-font';
import * as Notifications from 'expo-notifications';
import { type ErrorBoundaryProps, Stack, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, Keyboard, Platform, View } from 'react-native';

import { DataProblemScreen } from '@/components/DataProblemScreen';
import { ErrorScreen } from '@/components/ErrorScreen';
import { backToToday } from '@/components/today/backToToday';
import { installKeyboardBackGuard } from '@/platform/keyboardBack';
import { DataProvider, useData } from '@/store/DataContext';
import { persistErrorMessage } from '@/store/persistence';
import { dataProblemOf } from '@/store/problemCopy';
import { isReminderTap, type ReminderResponse, reminderTapKey, useReminderSync } from '@/store/reminderSync';
import { SnackbarProvider, useSnackbar } from '@/store/SnackbarContext';
import { ThemeProvider, useTheme } from '@/theme/ThemeContext';

SplashScreen.preventAutoHideAsync().catch(() => {});

// Android's Back with the keyboard open closes only the keyboard, on every
// screen (K1-1). At MODULE LOAD, so before the navigator adds its own Back
// listener (in an effect): every listener added later asks the guard first.
if (Platform.OS === 'android') installKeyboardBackGuard({ backHandler: BackHandler, keyboard: Keyboard });

/** Local notifications exist only in the native apps (not in the web preview). */
const NOTIFICATIONS_ON = Platform.OS === 'android' || Platform.OS === 'ios';

// A reminder that arrives while the app is open: show it (banner + list),
// quietly. Without a handler the system does not show it at all.
if (NOTIFICATIONS_ON) {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
}

/**
 * A tap on a reminder opens Today (spec §2.4 "Notification tap ─► Today").
 * Rendered only while the app's screens are shown (the navigator exists), and
 * only on a phone. It renders nothing.
 *
 * Today is shown by backToToday: over a session, Complete or a deck page it
 * pops the root stack back to the ONE tab navigator (a session on top is
 * banked by its own beforeRemove, M10); on the tabs it jumps to the Today
 * tab. `router.navigate('/(tabs)')` pushed a SECOND tab navigator on top,
 * and the session stayed mounted under it.
 */
function ReminderTapRouter() {
  const router = useRouter();
  // The first route segment on screen ('(tabs)', 'session', 'complete' …), read at the tap.
  const topSegment = useSegments()[0];
  const topRef = useRef(topSegment);
  useEffect(() => {
    topRef.current = topSegment;
  }, [topSegment]);
  // The tap that started the app (cold start); a later tap updates it too.
  const last = Notifications.useLastNotificationResponse();
  // The taps already handled, so the hook and the listener open Today once.
  const [handled] = useState(() => new Set<string>());

  const openToday = useCallback(
    (response: ReminderResponse | null | undefined) => {
      if (!isReminderTap(response)) return;
      const key = reminderTapKey(response);
      if (handled.has(key)) return;
      handled.add(key);
      backToToday(router, topRef.current);
      // Handled: a remount (for example "Try again") must not open Today again.
      // `clearLastNotificationResponse()` is the SDK 56 call (the `…Async`
      // form is deprecated). It is synchronous, but it THROWS when the native
      // module does not have it; a tap that opened Today is never an error.
      try {
        Notifications.clearLastNotificationResponse();
      } catch {
        // Nothing to do: the `handled` set above still stops a second open.
      }
    },
    [handled, router],
  );

  // Cold start (and any later tap the hook reports).
  useEffect(() => {
    openToday(last);
  }, [last, openToday]);

  // A tap while the app runs.
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((response) => openToday(response));
    return () => sub.remove();
  }, [openToday]);

  return null;
}

interface AppStackProps {
  /** How many times "Try again" reloaded the data (0 on a normal start). */
  loadAttempt: number;
  /** Load the saved data again (remounts the DataProvider). */
  onRetryLoad: () => void;
}

function AppStack({ loadAttempt, onRetryLoad }: AppStackProps) {
  const { colors, resolved, hydrated } = useTheme();
  const { ready, state, persistError } = useData();
  const { show } = useSnackbar();
  const router = useRouter();
  const tourShown = useRef(false);
  // 'read' / 'too-new' / 'migrate': the data layer saves nothing (C1), and
  // the app is replaced by the DataProblemScreen. null = the app can run.
  const problem = dataProblemOf(persistError);
  // The daily reminders follow the settings, the study day and the app state.
  useReminderSync();

  useEffect(() => {
    // Wait for BOTH the data layer and the theme preference, so the first frame
    // shown is the real palette — no light-flash before a dark preference (L21).
    // A data problem also ends the wait: its screen must be seen.
    if ((ready || problem) && hydrated) SplashScreen.hideAsync().catch(() => {});
  }, [ready, problem, hydrated]);

  // Surface a persistence failure instead of swallowing it (M15): a failed
  // save ('write', set on a mutation) was captured but never shown. The
  // snackbar host on the tab screens / editors renders it. A data problem gets
  // no snackbar: the DataProblemScreen says it in full (and has no host).
  useEffect(() => {
    if (problem) return;
    const msg = persistErrorMessage(persistError);
    if (msg) show(msg);
  }, [persistError, problem, show]);

  // first-run onboarding on first boot (F1) — and again after a factory
  // reset, which flips onboarded back to false. tourShown dedupes a single
  // transition; clearing it once onboarded lets a later reset re-trigger.
  // Never while a data problem is shown: no navigator is mounted then, and the
  // state is only the blank seed, not the user's data.
  useEffect(() => {
    if (!ready || problem) return;
    if (!state.onboarded && !tourShown.current) {
      tourShown.current = true;
      router.push('/onboarding');
    } else if (state.onboarded) {
      tourShown.current = false;
    }
  }, [ready, problem, state.onboarded, router]);

  let content: React.ReactNode;
  if (problem) {
    content = <DataProblemScreen kind={problem} onRetry={onRetryLoad} />;
  } else if (!ready && loadAttempt > 0) {
    // "Try again" is loading the data again. On a normal start the splash
    // screen hides this moment; after a retry it is already gone, so show a
    // quiet spinner instead of the app with the blank seed state.
    content = (
      <View
        accessible
        accessibilityLabel="Opening your saved data"
        style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}
      >
        <ActivityIndicator size="large" color={colors.pine} />
      </View>
    );
  } else {
    content = (
      <>
        <AppNavigator />
        {NOTIFICATIONS_ON && ready ? <ReminderTapRouter /> : null}
      </>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.paper }}>
      <StatusBar style={resolved === 'dark' ? 'light' : 'dark'} />
      {content}
    </View>
  );
}

/**
 * The app's screens (spec §2.2): the tabs, two pushed pages (the deck page
 * and Help) and the full-screen modals. Three of these routes are added by
 * other units of wave 4 (`deck/[id]`, `triage`, `help`).
 */
function AppNavigator() {
  const { colors } = useTheme();
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.paper },
      }}
    >
      <Stack.Screen name="(tabs)" />
      {/* Pushed pages (a card push: Android's back and the edge swipe go back). */}
      <Stack.Screen name="deck/[id]" options={{ presentation: 'card', animation: 'slide_from_right' }} />
      <Stack.Screen name="help" options={{ presentation: 'card', animation: 'slide_from_right' }} />
      {/* Full-screen modals. */}
      <Stack.Screen
        name="triage"
        options={{ presentation: 'fullScreenModal', animation: 'slide_from_bottom' }}
      />
      <Stack.Screen
        name="session"
        options={{ presentation: 'fullScreenModal', animation: 'fade_from_bottom', gestureEnabled: false }}
      />
      <Stack.Screen
        name="complete"
        options={{ presentation: 'fullScreenModal', animation: 'fade', gestureEnabled: false }}
      />
      <Stack.Screen
        name="card-editor"
        options={{ presentation: 'fullScreenModal', animation: 'slide_from_bottom' }}
      />
      <Stack.Screen
        name="deck-editor"
        options={{ presentation: 'fullScreenModal', animation: 'slide_from_bottom' }}
      />
      <Stack.Screen
        name="import"
        options={{ presentation: 'fullScreenModal', animation: 'slide_from_bottom' }}
      />
      <Stack.Screen
        name="onboarding"
        options={{ presentation: 'fullScreenModal', animation: 'fade', gestureEnabled: false }}
      />
    </Stack>
  );
}

/**
 * A crash anywhere in the app lands here: Expo Router renders this export when
 * the root layout or anything below it throws, unless a nearer layout has its
 * own (the (tabs) layout does). It renders OUTSIDE RootLayout, so none of
 * RootLayout's providers exist here: it brings its own ThemeProvider and never
 * uses the data layer. `retry` renders RootLayout again, which also mounts a
 * new DataProvider, so the saved data is loaded again.
 */
export function ErrorBoundary(props: ErrorBoundaryProps) {
  return (
    <ThemeProvider>
      <CrashStatusBar />
      <ErrorScreen {...props} />
    </ThemeProvider>
  );
}

function CrashStatusBar() {
  const { resolved } = useTheme();
  return <StatusBar style={resolved === 'dark' ? 'light' : 'dark'} />;
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Newsreader_400Regular,
    Newsreader_400Regular_Italic,
    Newsreader_500Medium,
    Newsreader_500Medium_Italic,
    Newsreader_600SemiBold,
    Newsreader_600SemiBold_Italic,
    Newsreader_700Bold,
    HankenGrotesk_400Regular,
    HankenGrotesk_500Medium,
    HankenGrotesk_600SemiBold,
    HankenGrotesk_700Bold,
    HankenGrotesk_800ExtraBold,
    SplineSansMono_400Regular,
    SplineSansMono_500Medium,
    SplineSansMono_600SemiBold,
  });

  // "Try again" on the DataProblemScreen adds 1 to this number. It is the
  // DataProvider's `key`, so React throws the old provider away and mounts a
  // new one, which reads the saved data again from the start. (The old one
  // writes nothing on the way out: its saves are blocked while read-blocked.)
  const [loadAttempt, setLoadAttempt] = useState(0);
  const retryLoad = useCallback(() => setLoadAttempt((n) => n + 1), []);

  // Proceed on a font-load ERROR too (OS falls back to system fonts) — otherwise
  // a CDN failure leaves fontsLoaded false forever and the app hangs on a blank
  // splash (L5).
  if (!fontsLoaded && !fontError) return null;

  return (
    <ThemeProvider>
      <DataProvider key={loadAttempt}>
        <SnackbarProvider>
          <AppStack loadAttempt={loadAttempt} onRetryLoad={retryLoad} />
        </SnackbarProvider>
      </DataProvider>
    </ThemeProvider>
  );
}
