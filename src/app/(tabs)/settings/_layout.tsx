/**
 * The Settings tab is a small Stack (spec §2.2, unit W4-5):
 *
 *   index      — the Settings hub
 *   study      — Study & limits            (push)
 *   reminders  — Reminders                 (push)
 *   data       — Your data                 (push)
 *   algorithm  — Algorithm (SM-2 settings) (push)
 *
 * WHY real routes (not local state, as before): Android's hardware back
 * closes a drill-in and goes back to the hub, instead of leaving the tab
 * (emulator check E15). The tab bar stays visible on every page.
 *
 * THE HUB IS ALWAYS THE FIRST PAGE (review round 2). Another screen can open
 * a drill-in directly: Today's "Want a daily reminder?" opens
 * `/(tabs)/settings/reminders?enable=1` (a plain `router.push`, the
 * cross-unit contract). The tabs are lazy, so the Settings stack is often not
 * mounted yet, and then expo-router builds it from the LAST route of the link
 * only: `[reminders]`, with no hub under it. "Back" would then leave the tab,
 * the tab would keep `[reminders]`, and the hub could not be reached again.
 *   - `unstable_settings.anchor = 'index'` puts the hub under a COLD deep
 *     link only (expo-router docs: the anchor is used only when deep-linking;
 *     an in-app push loads it only with `{ withAnchor: true }`).
 *   - So the stack repairs itself, whatever the caller did: on every focus
 *     and every state change of a page, `hubRepairListeners`
 *     (settingsIndex.ts) checks the stack, and when the hub is missing at the
 *     bottom the stack is reset to `[hub, …the same pages]`. The open page
 *     keeps its route key, so it is NOT mounted again (a `?enable=1` request
 *     runs once). settingsIndex.test.ts runs this on a real navigator.
 *
 *   Today → push '/(tabs)/settings/reminders?enable=1'
 *     stack [reminders] → reset → [index, reminders] → back → the hub
 */
import { Stack } from 'expo-router';
import React from 'react';

import { hubRepairListeners } from '@/components/settings/settingsIndex';
import { useColors } from '@/theme/ThemeContext';

export const unstable_settings = {
  // `anchor` replaces the deprecated `initialRouteName` (same meaning). A
  // plain literal: expo-router reads this object when it loads the routes.
  anchor: 'index',
};

export default function SettingsLayout() {
  const c = useColors();
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: c.paper },
        animation: 'slide_from_right',
      }}
      // The hub is always the first page (see the top of the file).
      screenListeners={hubRepairListeners}
    >
      <Stack.Screen name="index" />
      <Stack.Screen name="study" />
      <Stack.Screen name="reminders" />
      <Stack.Screen name="data" />
      <Stack.Screen name="algorithm" />
    </Stack>
  );
}
