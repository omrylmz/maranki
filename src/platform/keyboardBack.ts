/**
 * Android's hardware Back while the keyboard is open (final device pass K1-1).
 *
 * THE PROBLEM. On Android a Back press with the keyboard open should only
 * close the keyboard. But on newer Android versions (seen on Android 16,
 * API 36) the keyboard closes ITSELF on that Back press, and THEN the app
 * hears the same press as a normal Back. So one press did two things: the
 * keyboard closed AND the screen went back (Library search → the Today tab,
 * the card editor → "Discard changes?", Import → closed). The order of the
 * two events is not fixed: sometimes the app hears the press while the
 * keyboard is still open (Keyboard.isVisible() is true), sometimes the
 * keyboard is already gone (Keyboard.isVisible() is false), because
 * React Native learns about the hide a moment later or a moment earlier.
 *
 * THE RULE (one place, used by every screen):
 *   - the keyboard is open                          → close only the keyboard;
 *   - the keyboard closed BY ITSELF less than
 *     KEYBOARD_BACK_GRACE_MS (500 ms) ago            → this press was the one
 *     that closed it: take the press and do nothing else (once: the next
 *     press is a real Back);
 *   - anything else                                  → a normal Back.
 * "By itself" means: the app did not close it. When the app closes the
 * keyboard itself (the guard's own close, the session's "Check", any
 * `Keyboard.dismiss()` — see below), that hide is not a Back press, so it
 * never takes the next press (SELF_DISMISS_MS).
 * keyboardBackAction and hideOpensGrace are these rules as pure functions.
 * The study session had them first (wave-5b H1, wave 5c, review round 2);
 * sessionLogic.ts now re-exports the constants from here, so there is ONE
 * source of truth.
 *
 * HOW IT REACHES EVERY BACK LISTENER. React Native keeps a list of Back
 * listeners (BackHandler.addEventListener) and asks the NEWEST one first,
 * until one returns true. The navigator (expo-router) adds its own listener
 * in an effect, and some screens add their own (import, onboarding …).
 * `installKeyboardBackGuard` runs ONCE, when src/app/_layout.tsx is loaded
 * (before any effect, so before the navigator's listener exists). It wraps
 * `BackHandler.addEventListener`: every listener added AFTER that is stored
 * as "ask the guard first; only when the guard says 'pass', run the
 * listener". So the keyboard rule runs before any screen goes back, and no
 * screen has to remember it.
 *
 * HOW IT KNOWS EVERY CLOSE THE APP ASKS FOR. The install also wraps
 * `Keyboard.dismiss`: the wrapper first tells the guard "the app closes the
 * keyboard now" (markAppClosesKeyboard), then calls React Native's own
 * dismiss. WHY (review round 1): screens close the keyboard on purpose (the
 * Settings search: a tap on a result row calls Keyboard.dismiss() and opens a
 * page). The keyboardDidHide of such a close came about 250 ms later and
 * opened the Back window, so a Back press just after it (the user tapped the
 * wrong row) only did nothing. Now no screen has to remember to mark it.
 * Not covered: a close that does not go through Keyboard.dismiss (a text
 * field that loses focus when the user presses Enter, a tap on empty space
 * in a ScrollView). Such a hide still opens the 500 ms window.
 *
 * TWO MORE PLACES:
 *   - a Sheet is a React Native Modal. Android sends Back to the Modal (its
 *     onRequestClose), not to BackHandler. Sheet.tsx asks
 *     `backPressClosesKeyboard()` first, so Back in a sheet with a text
 *     field ("Save list", rename) first closes only the keyboard;
 *   - the study session has its OWN keyboard rule (it also checks that it is
 *     the focused screen, see sessionLogic backPressAction). It adds its
 *     listener with `addKeyboardAwareBackListener` (not wrapped, so the rule
 *     is not run twice) and tells the guard what it did
 *     (`markKeyboardBackPress`, `markAppClosesKeyboard`), so both stay in
 *     step: a press the session took for the keyboard is used up here too.
 *
 * Nothing here imports react-native: the BackHandler and the Keyboard are
 * passed in (`_layout.tsx` passes the real ones, the tests pass fakes).
 * iOS has no hardware Back, so `_layout.tsx` installs the guard on Android
 * only; without an install every function here does nothing.
 *
 * Example (what `_layout.tsx` does):
 *   if (Platform.OS === 'android') installKeyboardBackGuard({ backHandler: BackHandler, keyboard: Keyboard });
 */

/**
 * How long after the keyboard went away a hardware Back press still counts
 * as "the Back press that closed the keyboard" (ms). WHY: on Android the
 * keyboard can close itself on that Back press BEFORE the app hears it, so
 * `Keyboard.isVisible()` already says false. Without this window, the one
 * press that hid the keyboard also left the screen (wave-5b walkthrough H1,
 * final device pass K1-1).
 */
export const KEYBOARD_BACK_GRACE_MS = 500;

/**
 * How long after the app closed the keyboard ITSELF a keyboardDidHide is
 * still that close (ms). The event comes after the keyboard's slide-out
 * (about 250 ms), so this window is wider than that.
 */
export const SELF_DISMISS_MS = 1000;

/**
 * True when `ms` (the time since something happened) is inside a window of
 * `windowMs`: 0 ≤ ms < windowMs. A NEGATIVE value is never inside: it means
 * the clock went back (a manual time change, a network time correction),
 * not "it just happened". WHY (review round 2): with only `ms < windowMs`, a
 * clock that went back after a keyboard hide made every Back press "the
 * keyboard's" until the clock caught up, and Back could not leave.
 *
 *   withinMs(80, 500) → true · withinMs(500, 500) → false · withinMs(-3000, 500) → false
 */
export function withinMs(ms: number, windowMs: number): boolean {
  return ms >= 0 && ms < windowMs;
}

/** What a hardware Back press does about the keyboard (keyboardBackAction). */
export type KeyboardBackAction = 'closeKeyboard' | 'swallow' | 'pass';

/**
 * What a hardware Back press does about the keyboard (pure):
 *   'closeKeyboard'  the keyboard is open: close it; nothing else happens;
 *   'swallow'        the keyboard closed by itself less than
 *                    KEYBOARD_BACK_GRACE_MS ago: this press is the one that
 *                    closed it, so nothing else happens;
 *   'pass'           not the keyboard's press: a normal Back.
 * `msSinceKeyboardHid` = Infinity when no hide window is open (never hid,
 * the app closed it, or a press already used the window).
 *
 *   keyboardBackAction({ keyboardVisible: true, msSinceKeyboardHid: Infinity }) → 'closeKeyboard'
 *   keyboardBackAction({ keyboardVisible: false, msSinceKeyboardHid: 100 })     → 'swallow'
 *   keyboardBackAction({ keyboardVisible: false, msSinceKeyboardHid: 600 })     → 'pass'
 */
export function keyboardBackAction(s: { keyboardVisible: boolean; msSinceKeyboardHid: number }): KeyboardBackAction {
  if (s.keyboardVisible) return 'closeKeyboard';
  if (withinMs(s.msSinceKeyboardHid, KEYBOARD_BACK_GRACE_MS)) return 'swallow';
  return 'pass';
}

/**
 * Does a keyboardDidHide open the Back window (KEYBOARD_BACK_GRACE_MS)? Not
 * when the APP closed the keyboard itself less than SELF_DISMISS_MS ago:
 * such a hide is not a Back press, so the next Back press must work at once
 * (review round 2: a Back press just after "Check" was lost).
 * `msSinceAppClosed` = Infinity when the app did not close it.
 *
 *   hideOpensGrace(Infinity) → true · hideOpensGrace(300) → false
 */
export function hideOpensGrace(msSinceAppClosed: number): boolean {
  return !withinMs(msSinceAppClosed, SELF_DISMISS_MS);
}

/**
 * A clock that never goes back (ms), for the keyboard's short windows.
 * Date.now() can jump back (a manual time change, a network time
 * correction); `performance.now()` cannot. Listeners and handlers only
 * (React Compiler: never read a clock during render).
 */
export function steadyTime(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

/** A Back listener: true = "I handled this press" (React Native asks no older listener then). */
export type BackPressHandler = () => boolean | null | undefined;

/** The part of React Native's BackHandler the guard uses (the tests pass a fake). */
export interface BackHandlerLike {
  addEventListener(eventName: 'hardwareBackPress', handler: BackPressHandler): { remove(): void };
}

/** The part of React Native's Keyboard the guard uses (the tests pass a fake). */
export interface KeyboardLike {
  /** Is the keyboard open? (React Native: true from keyboardDidShow until keyboardDidHide.) */
  isVisible(): boolean;
  /**
   * Close the keyboard (React Native also takes the focus away from the text
   * field). The install wraps it, so every close the app asks for is known.
   */
  dismiss(): void;
  addListener(eventName: 'keyboardDidHide', listener: () => void): { remove(): void };
}

/** The guard's memory: when the keyboard hid by itself, and when the app closed it. */
export interface KeyboardBackGuard {
  /** The keyboard went away (keyboardDidHide). */
  onKeyboardDidHide(): void;
  /** The app closes the keyboard itself now: its hide must never take a Back press. */
  markAppClosesKeyboard(): void;
  /**
   * A Back press was the keyboard's (it closed the keyboard, or it was the
   * press that closed it by itself): keep the memory in step. `keyboardVisible`
   * = the keyboard was still open (it is closed now by the app).
   */
  markKeyboardBackPress(keyboardVisible: boolean): void;
  /** Ask the guard about a Back press: true = it was the keyboard's (handled), false = pass it on. */
  handleBackPress(): boolean;
}

/**
 * The guard (its memory and its decision), with no global effect: it does
 * not listen and wraps nothing (installKeyboardBackGuard does that).
 * `now` = the steady clock (a fake clock in the tests).
 */
export function createKeyboardBackGuard(keyboard: KeyboardLike, now: () => number = steadyTime): KeyboardBackGuard {
  // When the keyboard last hid BY ITSELF (the Back window is open), or null.
  let hidAt: number | null = null;
  // When the app last closed the keyboard itself, or null.
  let appClosedAt: number | null = null;
  const since = (at: number | null) => (at === null ? Infinity : now() - at);

  const markAppClosesKeyboard = () => {
    // Keyboard.isVisible() stays true until the hide event, so it says
    // whether a hide will come (none when it was closed already).
    if (keyboard.isVisible()) appClosedAt = now();
  };
  const markKeyboardBackPress = (keyboardVisible: boolean) => {
    // Still open: the app closes it now, and that hide must not take the
    // NEXT press. Closed by itself: this press was the one that closed it,
    // so the window is used up and the NEXT press is a real Back (wave 5c:
    // two quick presses were both taken).
    if (keyboardVisible) markAppClosesKeyboard();
    else hidAt = null;
  };

  return {
    onKeyboardDidHide() {
      // The NEWEST hide decides: a window of an older hide never stays open after it.
      hidAt = hideOpensGrace(since(appClosedAt)) ? now() : null;
      // A close the app asked for explains ONE hide only: the next hide is timed again.
      appClosedAt = null;
    },
    markAppClosesKeyboard,
    markKeyboardBackPress,
    handleBackPress() {
      const keyboardVisible = keyboard.isVisible();
      if (keyboardBackAction({ keyboardVisible, msSinceKeyboardHid: since(hidAt) }) === 'pass') return false;
      markKeyboardBackPress(keyboardVisible);
      // Also when it closed by itself: this takes the focus away from the
      // text field, the same as the session does.
      keyboard.dismiss();
      return true;
    },
  };
}

/** The listener-adding function of a BackHandler. */
type AddBackListener = BackHandlerLike['addEventListener'];

/**
 * The mark on a wrapped addEventListener: the function it wraps. A global
 * symbol, so a second install (a Fast Refresh of this file in development)
 * finds the old wrapper and wraps the ORIGINAL again, never a wrapper.
 */
const ORIGINAL_ADD: unique symbol = Symbol.for('maranki.keyboardBack.originalAdd');

/** A wrapped addEventListener carries the function it wraps. */
type WrappedAdd = AddBackListener & { [ORIGINAL_ADD]?: AddBackListener };

/** React Native's own addEventListener of a BackHandler (the guard's wrapper removed, if there is one). */
function originalAddOf(backHandler: BackHandlerLike): AddBackListener {
  const add = backHandler.addEventListener as WrappedAdd;
  return add[ORIGINAL_ADD] ?? add;
}

/** The close function of a Keyboard. */
type Dismiss = KeyboardLike['dismiss'];

/** The same mark on a wrapped Keyboard.dismiss: the function it wraps (see ORIGINAL_ADD). */
const ORIGINAL_DISMISS: unique symbol = Symbol.for('maranki.keyboardBack.originalDismiss');

/** A wrapped dismiss carries the function it wraps. */
type WrappedDismiss = Dismiss & { [ORIGINAL_DISMISS]?: Dismiss };

/** React Native's own dismiss of a Keyboard (the guard's wrapper removed, if there is one). */
function originalDismissOf(keyboard: KeyboardLike): Dismiss {
  const dismiss = keyboard.dismiss as WrappedDismiss;
  return dismiss[ORIGINAL_DISMISS] ?? dismiss;
}

/** An installed guard. `uninstall` puts the BackHandler and the Keyboard back the way they were (tests). */
export interface KeyboardBackInstall {
  guard: KeyboardBackGuard;
  uninstall(): void;
}

/** The installed guard (null before the install, on iOS, and in tests that do not install). */
let installed:
  | (KeyboardBackInstall & {
      backHandler: BackHandlerLike;
      keyboard: KeyboardLike;
      wrapped: AddBackListener;
      wrappedDismiss: Dismiss;
    })
  | null = null;

/**
 * Install the guard: listen to the keyboard's hides, wrap
 * `backHandler.addEventListener` so that every listener added from now on
 * asks the guard first, and wrap `keyboard.dismiss` so that every close the
 * app asks for is marked first (markAppClosesKeyboard: its hide never takes
 * a Back press). Once: a second call with the same BackHandler and Keyboard
 * gives the same install back (another pair replaces it). Call it before
 * any Back listener is added (at module load of src/app/_layout.tsx): a
 * listener added BEFORE the install is not guarded.
 *
 * The wrapper keeps React Native's rules: the same handler added twice is
 * stored once (one guarded copy per handler), and `remove()` removes it.
 *
 *   Keyboard.dismiss();  // after the install: mark "the app closes it", then React Native's own dismiss
 */
export function installKeyboardBackGuard(deps: {
  backHandler: BackHandlerLike;
  keyboard: KeyboardLike;
  now?: () => number;
}): KeyboardBackInstall {
  const { backHandler, keyboard } = deps;
  const same = installed && installed.backHandler === backHandler && installed.keyboard === keyboard;
  const intact = installed && backHandler.addEventListener === installed.wrapped && keyboard.dismiss === installed.wrappedDismiss;
  if (installed && same && intact) return installed;
  installed?.uninstall();

  const guard = createKeyboardBackGuard(keyboard, deps.now);
  const hideSub = keyboard.addListener('keyboardDidHide', () => guard.onKeyboardDidHide());
  const original = originalAddOf(backHandler);
  // One guarded copy per handler: React Native finds the same function again (no double add, remove works).
  const guardedOf = new WeakMap<BackPressHandler, BackPressHandler>();
  const wrapped: WrappedAdd = (eventName, handler) => {
    let guarded = guardedOf.get(handler);
    if (!guarded) {
      guarded = () => guard.handleBackPress() || handler();
      guardedOf.set(handler, guarded);
    }
    return original.call(backHandler, eventName, guarded);
  };
  wrapped[ORIGINAL_ADD] = original;
  backHandler.addEventListener = wrapped;

  // Every close the app asks for (any screen's Keyboard.dismiss(), the guard's
  // own too) is marked BEFORE it happens: Keyboard.isVisible() is still true
  // then, so the guard waits for its hide and does not open the Back window
  // for it (review round 1). An arrow function: it also works when a screen
  // passes `Keyboard.dismiss` on its own (`onSubmitEditing={Keyboard.dismiss}`).
  const originalDismiss = originalDismissOf(keyboard);
  const wrappedDismiss: WrappedDismiss = () => {
    guard.markAppClosesKeyboard();
    originalDismiss.call(keyboard);
  };
  wrappedDismiss[ORIGINAL_DISMISS] = originalDismiss;
  keyboard.dismiss = wrappedDismiss;

  const install = {
    guard,
    backHandler,
    keyboard,
    wrapped,
    wrappedDismiss,
    uninstall() {
      hideSub.remove();
      // Only when nobody replaced it since (a test spy, a second install).
      if (backHandler.addEventListener === wrapped) backHandler.addEventListener = original;
      if (keyboard.dismiss === wrappedDismiss) {
        // React Native's dismiss is a method of the Keyboard's class: removing
        // the wrapper (an own property) shows it again. Else put it back.
        Reflect.deleteProperty(keyboard, 'dismiss');
        if (keyboard.dismiss !== originalDismiss) keyboard.dismiss = originalDismiss;
      }
      if (installed === install) installed = null;
    },
  };
  installed = install;
  return install;
}

/**
 * Add a Back listener that handles the keyboard ITSELF (the study session):
 * it is NOT wrapped by the guard, so the keyboard rule does not run twice.
 * Such a listener must tell the guard what it did (markKeyboardBackPress,
 * markAppClosesKeyboard). Without an install it is a normal
 * `backHandler.addEventListener`.
 */
export function addKeyboardAwareBackListener(backHandler: BackHandlerLike, handler: BackPressHandler): { remove(): void } {
  return originalAddOf(backHandler).call(backHandler, 'hardwareBackPress', handler);
}

/**
 * For a Modal's onRequestClose (Sheet.tsx): is this Back press the
 * keyboard's? If yes, it closes only the keyboard and returns true (the
 * Modal stays open). False without an install (iOS, tests).
 *
 *   onRequestClose={() => { if (!backPressClosesKeyboard()) onClose(); }}
 */
export function backPressClosesKeyboard(): boolean {
  return installed ? installed.guard.handleBackPress() : false;
}

/**
 * The app closes the keyboard itself now ("Check"): tell the installed guard
 * (nothing without one). A Keyboard.dismiss() after the install marks this
 * by itself; this is for a close that does not go through it.
 */
export function markAppClosesKeyboard(): void {
  installed?.guard.markAppClosesKeyboard();
}

/**
 * A listener that handles the keyboard itself (the session) took this Back
 * press as the keyboard's: tell the installed guard, so it is used up here
 * too (nothing without an install). See KeyboardBackGuard.markKeyboardBackPress.
 */
export function markKeyboardBackPress(keyboardVisible: boolean): void {
  installed?.guard.markKeyboardBackPress(keyboardVisible);
}
