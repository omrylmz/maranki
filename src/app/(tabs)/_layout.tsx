/**
 * The 4-tab bar (spec §2.1, unit W4-1): Today · Library · Progress · Settings.
 * One job per tab: Today = do today's studying, Library = find, filter and
 * manage cards, Progress = see how you are doing, Settings = change how the
 * app behaves. (The old Study tab is gone: Today's "Study {n}" is the one
 * "study everything" control.)
 *
 * Custom bar matching ui.jsx TabBar — a solid surface over the content,
 * hairline top border, outline→filled icon flip, and an amber ready-count
 * badge on Today. The badge is `readyFor({}).total` (useReady), the SAME
 * number as Today's "Study {n}" button. It is amber, not red: red is kept for
 * errors (spec §2.1).
 *
 * The bar is OPAQUE (wave 5b L1): `solidColor(c.tabbarBg)`, the theme's tab
 * bar colour at full strength. The bar floats over the screens, and the
 * design token is a little see-through (92 % in Paper, 90 % in Evening), so
 * the list text of every tab showed through under the tab labels (very
 * visible in Evening). One solid bar fixes it for every tab at once; the
 * screens keep their bottom padding, so their last row still scrolls above it.
 *
 * The bar draws the 4 tabs by ROUTE NAME, not by position: a tab whose route
 * file does not exist (yet) is simply not drawn, and any other route in this
 * folder never gets a button.
 *
 * A tab press KEEPS the tab's route params, like React Navigation's own
 * BottomTabBar (W4-1 review round 2). Why: the tab router REPLACES a route's
 * params on a navigate without params. Today opens Library with `q` (the
 * filters) and a `nonce` (spec §4.6). If a later tab press removed them, the
 * nonce would change (to undefined) and Library would reset its filters:
 * Today › list "B1 verbs" → Library → Progress → Library tab = every chip gone.
 * With the same params object, the nonce stays the same, so Library keeps
 * what the learner chose (and a nested stack, like Settings, does not
 * navigate again: its params were already used).
 *
 *   navigation.navigate(route.name, route.params)   // not navigate(route.name)
 *
 * Accessibility (spec §8.12): each button is a "tab" with its selected state;
 * Today's label says the ready count ("Today, 30 cards ready"); the labels
 * grow with the system font size, at most 1.3 times, so the bar never breaks.
 *
 * A crash inside the tabs shows the ErrorScreen (the `ErrorBoundary` export
 * below), not a white screen (spec W1-4).
 *
 * The automatic weekly backup (useAutoBackup, spec §8.4, unit W2-2) runs from
 * here: this layout is mounted once, only while the app shows the user's data
 * (never on the DataProblemScreen), and it stays mounted while the tabs change.
 *
 * The Library's cache warm-up (useLibraryWarmup, unit P2) runs from here for
 * the same reason: the Library is a lazy tab, and its own warm-up started too
 * late (a fast learner typed before the search text was ready). It starts
 * 1.5 s after the app is ready, in small idle slices, so the caches are
 * usually warm before the learner opens the Library (src/store/libraryWarmup.ts).
 * A Library opened sooner than that asks for it 400 ms after it opened
 * (unit P3, useLibraryWarmupSoon in library.tsx): still this ONE warm-up,
 * and still nothing before the app is ready.
 */
import { type ErrorBoundaryProps, Tabs } from 'expo-router';
import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ErrorScreen } from '@/components/ErrorScreen';
import { A11Y_HIDDEN, Ion, SnackbarHost } from '@/components/ui';
import { ALL_SCOPE } from '@/components/today/todayLogic';
import { plural } from '@/domain/text';
import { useAutoBackup } from '@/store/autoBackup';
import { useLibraryWarmup } from '@/store/libraryWarmup';
import { useReady } from '@/store/selectors';
import { font, TABBAR_HEIGHT } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

/** The tabs, in bar order. `name` is the route file in this folder. */
export const TABS: readonly { name: string; icon: string; label: string }[] = [
  { name: 'index', icon: 'today', label: 'Today' },
  { name: 'library', icon: 'library', label: 'Library' },
  { name: 'progress', icon: 'bar-chart', label: 'Progress' },
  { name: 'settings', icon: 'settings', label: 'Settings' },
];

/**
 * The same colour with nothing see-through: 'rgba(35, 32, 25, 0.9)' →
 * 'rgb(35, 32, 25)', '#23201980' → '#232019'. Any other text (a plain
 * '#RRGGBB', a name) is already solid and comes back as it is. PURE.
 */
export function solidColor(color: string): string {
  const rgba = /^rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*[\d.]+\s*\)$/i.exec(color.trim());
  if (rgba) return `rgb(${rgba[1]}, ${rgba[2]}, ${rgba[3]})`;
  const hex8 = /^#([0-9a-f]{6})[0-9a-f]{2}$/i.exec(color.trim());
  if (hex8) return `#${hex8[1]}`;
  return color;
}

/** The biggest the tab labels grow with the system font size (spec §8.12). */
export const TAB_LABEL_MAX_SCALE = 1.3;

/** The slice of BottomTabBarProps the custom bar actually uses (the full
 *  type clashes between expo-router's vendored copy and the standalone
 *  @react-navigation/bottom-tabs package). */
export interface TabBarProps {
  state: { index: number; routes: { key: string; name: string; params?: object }[] };
  navigation: {
    emit: (e: {
      type: 'tabPress';
      target: string;
      canPreventDefault: true;
    }) => { defaultPrevented: boolean };
    navigate: (name: string, params?: object) => void;
  };
}

/**
 * The bar itself. Exported for the wiring test (todayLogic.test.ts): the 4
 * tabs, the badge = readyFor({}).total, the labels, and a press that keeps
 * the tab's params.
 */
export function MarankiTabBar({ state, navigation }: TabBarProps) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  // The number of Today's "Study {n}" button: the session it opens has exactly this many cards.
  const ready = useReady(ALL_SCOPE).total;
  const current = state.routes[state.index]?.name;

  return (
    <View
      accessibilityRole="tablist"
      style={{
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        height: TABBAR_HEIGHT + insets.bottom,
        // Solid, so no list text shows through under the labels (see the top of the file).
        backgroundColor: solidColor(c.tabbarBg),
        borderTopWidth: 1,
        borderTopColor: c.hairline,
        flexDirection: 'row',
        alignItems: 'flex-start',
        paddingTop: 9,
        zIndex: 40,
      }}
    >
      {TABS.map((tab) => {
        const route = state.routes.find((r) => r.name === tab.name);
        if (!route) return null;
        const on = current === tab.name;
        const badge = tab.name === 'index' ? ready : 0;
        return (
          <Pressable
            key={tab.name}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={badge > 0 ? `${tab.label}, ${plural(badge, 'card')} ready` : tab.label}
            onPress={() => {
              const event = navigation.emit({
                type: 'tabPress',
                target: route.key,
                canPreventDefault: true,
              });
              if (!on && !event.defaultPrevented) {
                // Keep the tab's params (Library's q + nonce): see the file header.
                navigation.navigate(route.name, route.params);
              }
            }}
            style={{ flex: 1, alignItems: 'center', gap: 3 }}
          >
            <View {...A11Y_HIDDEN}>
              <Ion
                name={on ? tab.icon : `${tab.icon}-outline`}
                size={23}
                color={on ? c.pine : c.ink3}
              />
              {badge > 0 && (
                <View
                  style={{
                    position: 'absolute',
                    top: -4,
                    right: -11,
                    minWidth: 16,
                    height: 16,
                    paddingHorizontal: 4,
                    backgroundColor: c.amber,
                    borderRadius: 999,
                    borderWidth: 1.5,
                    borderColor: c.surface,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Text
                    maxFontSizeMultiplier={TAB_LABEL_MAX_SCALE}
                    // inkOnAmber, not white: white on amber was 2.7:1 (Paper) / 2.3:1 (Evening).
                    style={[font('sans', 800), { fontSize: 10, color: c.inkOnAmber }]}
                  >
                    {badge > 99 ? '99+' : badge}
                  </Text>
                </View>
              )}
            </View>
            <Text
              maxFontSizeMultiplier={TAB_LABEL_MAX_SCALE}
              numberOfLines={1}
              style={[
                font('sans', on ? 800 : 500),
                { fontSize: 10.5, color: on ? c.pine : c.ink3 },
              ]}
            >
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * A crash in any tab (or in the tab bar) lands here instead of a white screen.
 * Expo Router renders this export in place of the tabs layout; the root
 * providers (theme, data, snackbar) are still above it. `retry` renders the
 * tabs again.
 */
export function ErrorBoundary(props: ErrorBoundaryProps) {
  return <ErrorScreen {...props} />;
}

export default function TabsLayout() {
  const c = useColors();
  // A weekly backup on this phone, a few seconds after the data is loaded.
  useAutoBackup();
  // The Library's caches (search text first), warmed in idle slices from 1.5 s after the app is
  // ready (or 400 ms after the Library opened, when that is sooner: unit P3).
  useLibraryWarmup();
  return (
    <View style={{ flex: 1 }}>
      <Tabs
        tabBar={(props) => <MarankiTabBar {...props} />}
        screenOptions={{
          headerShown: false,
          sceneStyle: { backgroundColor: c.paper },
          lazy: true,
          freezeOnBlur: true,
        }}
      >
        {TABS.map((tab) => (
          <Tabs.Screen key={tab.name} name={tab.name} />
        ))}
      </Tabs>
      <SnackbarHost />
    </View>
  );
}
