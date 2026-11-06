/**
 * Back to Today from anywhere: Complete's "Done", the end of the first-run
 * tour, a tap on a reminder (spec §2.4 "Notification tap ─► Today").
 *
 * The app's root stack (src/app/_layout.tsx) holds ONE tab navigator, the
 * `(tabs)` route, at the bottom. Every full-screen modal (session, Complete,
 * the tour, triage …) and every pushed page (the deck page) sits above it.
 *
 *   - A screen ABOVE the tabs is on top → `router.dismissTo('/(tabs)')`: the
 *     root stack pops back to the tab navigator that is already there, and
 *     that navigator shows its first tab, Today. When no `(tabs)` route is
 *     in the stack (a deep link), dismissTo puts it in place of the top
 *     screen, like `replace` did.
 *   - The tabs themselves are on top → `router.navigate('/(tabs)')`: it
 *     jumps to the Today tab inside that ONE navigator. (A POP_TO would go
 *     to the tab navigator, which cannot handle it: nothing would happen.)
 *
 * WHY never `router.replace('/(tabs)')` / `router.navigate('/(tabs)')` from a
 * screen above the tabs: in expo-router 56 both put a NEW `(tabs)` route
 * (a new key) on the root stack, above the old one. The old tab app stays
 * mounted underneath: every "Done" added one more full copy (its own Today,
 * tab badge and auto-backup hook, all computed again on every rating), and
 * Android's Back on Today showed the older Today, or the old deck page,
 * instead of leaving the app.
 *
 *   root [(tabs), complete]             → backToToday(router)            → [(tabs)] on Today
 *   root [(tabs), deck/[id], complete]  → backToToday(router)            → [(tabs)] on Today
 *   root [(tabs)] on Library            → backToToday(router, '(tabs)')  → [(tabs)] on Today
 *
 * The tests (backToToday.test.ts) run these on expo-router's real router.
 */
import type { ImperativeRouter } from 'expo-router';

/** The href of the tab navigator; it opens on its first tab, Today. */
export const TODAY_HREF = '/(tabs)';

/** The first route segment of every tab screen (`useSegments()[0]`): the tab navigator's group. */
export const TABS_SEGMENT = '(tabs)';

/** The two router calls backToToday needs (the screens pass `useRouter()`). */
export type TodayRouter = Pick<ImperativeRouter, 'dismissTo' | 'navigate'>;

/**
 * Show Today, with exactly one tab navigator in the root stack.
 * `topSegment` = the first route segment on screen (`useSegments()[0]`:
 * '(tabs)' on a tab, 'complete', 'session', 'deck' …); leave it out from a
 * screen that is itself above the tabs (Complete, the tour).
 */
export function backToToday(router: TodayRouter, topSegment?: string): void {
  if (topSegment === TABS_SEGMENT) router.navigate(TODAY_HREF);
  else router.dismissTo(TODAY_HREF);
}
