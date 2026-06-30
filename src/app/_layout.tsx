/**
 * Root layout — providers, fonts, and the overlay stack.
 * Mirrors app.jsx's orchestration: 5 tabs + full-screen overlays
 * (session / complete / editors / import / onboarding), the global
 * snackbar, and theme resolution (paper ⇆ evening).
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
import { Stack, useRouter } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useRef } from 'react';
import { View } from 'react-native';

import { DataProvider, useData } from '@/store/DataContext';
import { SnackbarProvider } from '@/store/SnackbarContext';
import { ThemeProvider, useTheme } from '@/theme/ThemeContext';

SplashScreen.preventAutoHideAsync().catch(() => {});

function AppStack() {
  const { colors, resolved } = useTheme();
  const { ready, state } = useData();
  const router = useRouter();
  const tourShown = useRef(false);

  useEffect(() => {
    if (ready) SplashScreen.hideAsync().catch(() => {});
  }, [ready]);

  // language-first onboarding on first boot (F1) — and again after a factory
  // reset, which flips onboarded back to false. tourShown dedupes a single
  // transition; clearing it once onboarded lets a later reset re-trigger.
  useEffect(() => {
    if (!ready) return;
    if (!state.onboarded && !tourShown.current) {
      tourShown.current = true;
      router.push('/onboarding');
    } else if (state.onboarded) {
      tourShown.current = false;
    }
  }, [ready, state.onboarded, router]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.paper }}>
      <StatusBar style={resolved === 'dark' ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.paper },
        }}
      >
        <Stack.Screen name="(tabs)" />
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
    </View>
  );
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
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

  if (!fontsLoaded) return null;

  return (
    <ThemeProvider>
      <DataProvider>
        <SnackbarProvider>
          <AppStack />
        </SnackbarProvider>
      </DataProvider>
    </ThemeProvider>
  );
}
