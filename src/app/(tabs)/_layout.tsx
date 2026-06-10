/**
 * The 5-tab bar: Home · Study · Library · Progress · Settings.
 * Custom bar matching ui.jsx TabBar — translucent surface over content,
 * hairline top border, outline→filled icon flip, red ready-count badge
 * on Study (READY.total, the same trustworthy number the Home hero uses).
 */
import { Tabs } from 'expo-router';
import React, { useMemo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Ion, SnackbarHost } from '@/components/ui';
import { computeReady } from '@/domain/queue';
import { normalizedDayDone, useData } from '@/store/DataContext';
import { useNow } from '@/store/useNow';
import { font, TABBAR_HEIGHT } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

const TABS: { name: string; icon: string; label: string }[] = [
  { name: 'index', icon: 'home', label: 'Home' },
  { name: 'study', icon: 'book', label: 'Study' },
  { name: 'browse', icon: 'search', label: 'Library' },
  { name: 'stats', icon: 'bar-chart', label: 'Progress' },
  { name: 'settings', icon: 'settings', label: 'Settings' },
];

/** The slice of BottomTabBarProps the custom bar actually uses (the full
 *  type clashes between expo-router's vendored copy and the standalone
 *  @react-navigation/bottom-tabs package). */
interface TabBarProps {
  state: { index: number; routes: { key: string; name: string }[] };
  navigation: {
    emit: (e: {
      type: 'tabPress';
      target: string;
      canPreventDefault: true;
    }) => { defaultPrevented: boolean };
    navigate: (name: string) => void;
  };
}

function MarankiTabBar({ state, navigation }: TabBarProps) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { state: data } = useData();

  const now = useNow();
  const studyDue = useMemo(() => {
    return computeReady(
      data.cards.filter((card) => {
        const deck = data.decks.find((d) => d.id === card.deckId);
        return deck?.active !== false;
      }),
      data.settings.srs,
      normalizedDayDone(data.person, now),
      now,
    ).total;
  }, [data, now]);

  return (
    <View
      style={{
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        height: TABBAR_HEIGHT + insets.bottom,
        backgroundColor: c.tabbarBg,
        borderTopWidth: 1,
        borderTopColor: c.hairline,
        flexDirection: 'row',
        alignItems: 'flex-start',
        paddingTop: 9,
        zIndex: 40,
      }}
    >
      {TABS.map((tab, i) => {
        const on = state.index === i;
        const badge = tab.name === 'study' ? studyDue : 0;
        return (
          <Pressable
            key={tab.name}
            onPress={() => {
              const event = navigation.emit({
                type: 'tabPress',
                target: state.routes[i].key,
                canPreventDefault: true,
              });
              if (!on && !event.defaultPrevented) {
                navigation.navigate(state.routes[i].name);
              }
            }}
            style={{ flex: 1, alignItems: 'center', gap: 3 }}
          >
            <View>
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
                    backgroundColor: c.danger,
                    borderRadius: 999,
                    borderWidth: 1.5,
                    borderColor: c.surface,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Text style={[font('sans', 800), { fontSize: 10, color: '#fff' }]}>
                    {badge > 99 ? '99+' : badge}
                  </Text>
                </View>
              )}
            </View>
            <Text
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

export default function TabsLayout() {
  const c = useColors();
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
        <Tabs.Screen name="index" />
        <Tabs.Screen name="study" />
        <Tabs.Screen name="browse" />
        <Tabs.Screen name="stats" />
        <Tabs.Screen name="settings" />
      </Tabs>
      <SnackbarHost />
    </View>
  );
}
