/**
 * backToToday (src/components/today/backToToday.ts): "Done" on Complete, the
 * end of the first-run tour and a reminder tap show Today with exactly ONE
 * tab navigator in the root stack.
 *
 * The router here is REAL: expo-router's own ExpoRoot, Stack and Tabs
 * (`renderRouter` from expo-router/testing-library), on a route tree with
 * the app's shape (src/app): a root Stack with the `(tabs)` group (Today,
 * Library), the deck page, the session, Complete and the tour. The screens
 * are stubs that count their mounts. expo-router's testing library draws
 * with @testing-library/react-native, which this repo does not install; a
 * small stand-in on react-test-renderer does the same job (`render`, `act`).
 *
 * Final review (session area): `router.replace('/(tabs)')` from Complete put
 * a SECOND `(tabs)` route on the root stack ([(tabs), (tabs)]), and the old
 * tab app stayed mounted under it — one more copy after every session.
 */
// '@jest/globals' first: the jest.mock factory below uses its `jest`.
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { router, Stack, Tabs } from 'expo-router';
import { renderRouter } from 'expo-router/testing-library';
import React, { useEffect } from 'react';
import { act } from 'react-test-renderer';

import { backToToday, TABS_SEGMENT, TODAY_HREF } from './backToToday';

// expo-router/testing-library requires @testing-library/react-native, which this repo does not
// install: a stand-in on react-test-renderer (jest.mock is hoisted above the imports).
jest.mock(
  '@testing-library/react-native',
  () => {
    const TR = jest.requireActual<typeof import('react-test-renderer')>('react-test-renderer');
    let current: import('react-test-renderer').ReactTestRenderer | null = null;
    return {
      act: TR.act,
      render: (element: React.ReactElement) => {
        TR.act(() => {
          current = TR.create(element);
        });
        return {
          unmount: () =>
            TR.act(() => {
              current?.unmount();
              current = null;
            }),
        };
      },
      get screen() {
        return {};
      },
    };
  },
  { virtual: true },
);

/** How often each screen was mounted (the screens' effects write it). */
const mounts = { tabs: 0, today: 0 };

function counted(name: keyof typeof mounts, child: () => React.ReactElement | null) {
  return function Counted() {
    useEffect(() => {
      mounts[name] += 1;
    }, []);
    return child();
  };
}

/** The app's route tree (src/app), with stub screens. */
const APP = {
  _layout: () => React.createElement(Stack, { screenOptions: { headerShown: false } }),
  '(tabs)/_layout': counted('tabs', () => React.createElement(Tabs, { screenOptions: { headerShown: false } })),
  '(tabs)/index': counted('today', () => null),
  '(tabs)/library': () => null,
  'deck/[id]': () => null,
  session: () => null,
  complete: () => null,
  onboarding: () => null,
};

type Screen = ReturnType<typeof renderRouter>;
let screen: Screen | null = null;

function mount(): Screen {
  mounts.tabs = 0;
  mounts.today = 0;
  screen = renderRouter(APP, { initialUrl: '/' });
  return screen;
}

afterEach(() => {
  screen?.unmount();
  screen = null;
  jest.useRealTimers();
});

/** A navigation state, as far as these tests read it. */
interface NavState {
  index?: number;
  routes: { name: string; state?: NavState }[];
}

/** The root layout's Stack (expo-router wraps it in its own `__root` route). */
function rootStack(s: Screen): NavState | undefined {
  const container = s.getRouterState() as NavState | undefined;
  return container?.routes.find((r) => r.name === '__root')?.state;
}

/** The root stack's routes, by name. */
function rootRoutes(s: Screen): string[] {
  return (rootStack(s)?.routes ?? []).map((r) => r.name);
}

/** The tab on screen inside the ONE `(tabs)` route. */
function tabOnScreen(s: Screen): string | undefined {
  const tabs = rootStack(s)?.routes.find((r) => r.name === TABS_SEGMENT)?.state;
  return tabs ? tabs.routes[tabs.index ?? 0]?.name : undefined;
}

function go(fn: () => void) {
  act(() => {
    fn();
  });
  // Let the router's queued actions and the screens' effects run.
  act(() => {
    jest.runOnlyPendingTimers();
  });
}

describe('backToToday: Today, with ONE tab navigator in the root stack', () => {
  test('Complete "Done" after a session from Today: [(tabs)] on Today, the tab app never mounted twice', () => {
    const s = mount();
    expect(rootRoutes(s)).toEqual(['(tabs)']);
    for (let session = 1; session <= 3; session += 1) {
      go(() => router.push('/session'));
      go(() => router.replace('/complete')); // session.tsx opens Complete like this
      expect(rootRoutes(s)).toEqual(['(tabs)', 'complete']);
      go(() => backToToday(router));
      expect(rootRoutes(s)).toEqual(['(tabs)']);
      expect(s.getPathname()).toBe('/');
    }
    expect(mounts.tabs).toBe(1);
    expect(mounts.today).toBe(1);
    expect(router.canGoBack()).toBe(false); // Android's Back leaves the app
  });

  test('"Done" after a session started on a deck page: the deck page goes too, Today is on screen', () => {
    const s = mount();
    go(() => router.push('/deck/d1'));
    go(() => router.push('/session'));
    go(() => router.replace('/complete'));
    expect(rootRoutes(s)).toEqual(['(tabs)', 'deck/[id]', 'complete']);
    go(() => backToToday(router));
    expect(rootRoutes(s)).toEqual(['(tabs)']);
    expect(s.getPathname()).toBe('/');
    expect(mounts.tabs).toBe(1);
  });

  test('"Done" after a session started on the Library tab lands on the Today tab', () => {
    const s = mount();
    go(() => router.navigate('/library'));
    expect(tabOnScreen(s)).toBe('library');
    go(() => router.push('/session'));
    go(() => router.replace('/complete'));
    go(() => backToToday(router));
    expect(rootRoutes(s)).toEqual(['(tabs)']);
    expect(tabOnScreen(s)).toBe('index');
    expect(mounts.tabs).toBe(1);
  });

  test('the first-run tour (pushed over the tabs) ends on Today without a second tab navigator', () => {
    const s = mount();
    go(() => router.push('/onboarding'));
    go(() => backToToday(router));
    expect(rootRoutes(s)).toEqual(['(tabs)']);
    expect(mounts.tabs).toBe(1);
  });

  test('a reminder tap: from a session it pops back to the tabs; on the tabs it jumps to Today', () => {
    const s = mount();
    const top = () => s.getSegments()[0];
    go(() => router.push('/session'));
    expect(top()).toBe('session');
    go(() => backToToday(router, top()));
    expect(rootRoutes(s)).toEqual(['(tabs)']);
    // Already on the tabs (Library): the Today tab, still one navigator.
    go(() => router.navigate('/library'));
    expect(top()).toBe(TABS_SEGMENT);
    go(() => backToToday(router, top()));
    expect(rootRoutes(s)).toEqual(['(tabs)']);
    expect(tabOnScreen(s)).toBe('index');
    expect(mounts.tabs).toBe(1);
  });
});

describe('backToToday: the router call it makes', () => {
  test('above the tabs (or unknown): dismissTo; on the tabs: navigate', () => {
    const calls: string[] = [];
    const fake = {
      dismissTo: (href: unknown) => void calls.push(`dismissTo ${String(href)}`),
      navigate: (href: unknown) => void calls.push(`navigate ${String(href)}`),
    };
    backToToday(fake);
    backToToday(fake, 'complete');
    backToToday(fake, TABS_SEGMENT);
    expect(calls).toEqual([`dismissTo ${TODAY_HREF}`, `dismissTo ${TODAY_HREF}`, `navigate ${TODAY_HREF}`]);
  });
});
