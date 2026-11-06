/**
 * Android's hardware Back while the keyboard is open (src/platform/keyboardBack.ts,
 * final device pass K1-1).
 *
 * Three parts:
 *   1. the PURE rules: keyboardBackAction (open → close only the keyboard;
 *      closed by itself < 500 ms ago → take the press; else → a normal Back),
 *      hideOpensGrace (a close the app asked for is never a Back press) and
 *      withinMs;
 *   2. the guard installed on a FAKE BackHandler and a FAKE Keyboard, which
 *      work like React Native's on Android: the newest Back listener is asked
 *      first, until one returns true; Keyboard.isVisible() stays true until
 *      keyboardDidHide; dismiss() only asks the keyboard to close (`dismissed`
 *      counts its real closes: the install wraps `dismiss`). A fake
 *      clock (`advance`) times the windows. Checked: every listener added
 *      after the install asks the guard first (the navigator's own one too),
 *      remove() really removes it, React Native's "same handler once" rule,
 *      the window takes ONE press, the app's own close never takes one, and a
 *      listener that handles the keyboard itself (the study session) stays in
 *      step with the guard;
 *   3. Sheet (a React Native Modal: Android sends Back to its onRequestClose,
 *      not to BackHandler): with the keyboard open the first Back press closes
 *      only the keyboard, the next one closes the sheet.
 *
 * Module mocks (`jest.mock` below, for part 3): ThemeContext (the light
 * palette), safe-area-context (zero insets), vector icons (render nothing).
 */
// '@jest/globals' first: the jest.mock factories below use its `jest`.
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import React from 'react';
import { Modal, Text } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { Sheet } from '../components/ui/Sheet';
import {
  addKeyboardAwareBackListener,
  type BackHandlerLike,
  type BackPressHandler,
  backPressClosesKeyboard,
  createKeyboardBackGuard,
  hideOpensGrace,
  installKeyboardBackGuard,
  KEYBOARD_BACK_GRACE_MS,
  keyboardBackAction,
  type KeyboardBackInstall,
  type KeyboardLike,
  markAppClosesKeyboard,
  markKeyboardBackPress,
  SELF_DISMISS_MS,
  steadyTime,
  withinMs,
} from './keyboardBack';

jest.mock('../theme/ThemeContext', () => ({
  useColors: () => jest.requireActual<typeof import('../theme/tokens')>('../theme/tokens').light,
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

const h = React.createElement;

/* ================================================================ fakes */

/** React Native's BackHandler on Android: a list; a press asks the NEWEST listener first, until one returns true. */
interface FakeBackHandler extends BackHandlerLike {
  /** A hardware Back press: true when a listener took it (else Android would leave the app). */
  press(): boolean;
  /** How many listeners are stored. */
  size(): number;
}

function fakeBackHandler(): FakeBackHandler {
  const list: BackPressHandler[] = [];
  return {
    // The same rules as React Native's BackHandler.android.js: one entry per handler, remove() by identity.
    addEventListener(_eventName, handler) {
      if (list.indexOf(handler) === -1) list.push(handler);
      return {
        remove: () => {
          const at = list.indexOf(handler);
          if (at !== -1) list.splice(at, 1);
        },
      };
    },
    press() {
      for (let i = list.length - 1; i >= 0; i--) if (list[i]?.()) return true;
      return false;
    },
    size: () => list.length,
  };
}

/** React Native's Keyboard: isVisible() is true from keyboardDidShow until keyboardDidHide. */
interface FakeKeyboard extends KeyboardLike {
  /**
   * How often the keyboard's OWN dismiss ran (the install wraps `dismiss`, so
   * `keyboard.dismiss` itself is the guard's wrapper after the install).
   */
  dismissed: jest.Mock<() => void>;
  /** The keyboard opens (keyboardDidShow). */
  open(): void;
  /** The keyboard went away (keyboardDidHide): by itself, or after dismiss(). */
  didHide(): void;
  /** How many keyboardDidHide listeners there are. */
  hideListeners(): number;
}

function fakeKeyboard(): FakeKeyboard {
  let visible = false;
  let listeners: (() => void)[] = [];
  const dismissed = jest.fn<() => void>();
  return {
    isVisible: () => visible,
    // Like React Native: it only ASKS the keyboard to close; the hide event comes later.
    dismiss: () => dismissed(),
    dismissed,
    addListener(_eventName, listener) {
      listeners.push(listener);
      return { remove: () => void (listeners = listeners.filter((l) => l !== listener)) };
    },
    open() {
      visible = true;
    },
    didHide() {
      visible = false;
      for (const l of [...listeners]) l();
    },
    hideListeners: () => listeners.length,
  };
}

/** The fake steady clock (ms). */
let clock = 10_000;
const now = () => clock;
function advance(ms: number): void {
  clock += ms;
}

/** The install of the current test (removed after each test, so no test sees another's guard). */
let install: KeyboardBackInstall | null = null;
let renderer: ReactTestRenderer | null = null;

afterEach(() => {
  if (renderer) act(() => renderer!.unmount());
  renderer = null;
  install?.uninstall();
  install = null;
  jest.useRealTimers();
});

/** A fake phone with the guard installed (like src/app/_layout.tsx does on Android). */
function phone() {
  const backHandler = fakeBackHandler();
  const keyboard = fakeKeyboard();
  install = installKeyboardBackGuard({ backHandler, keyboard, now });
  return { backHandler, keyboard };
}

/** A Back listener that "goes back" (like the navigator's own one): it returns true. */
const goesBack = () => jest.fn<BackPressHandler>(() => true);

/* ================================================================ 1. the pure rules */

describe('the pure rules', () => {
  test('keyboardBackAction: open → close only the keyboard; closed by itself < 500 ms ago → take the press; else a normal Back', () => {
    expect(KEYBOARD_BACK_GRACE_MS).toBe(500);
    expect(keyboardBackAction({ keyboardVisible: true, msSinceKeyboardHid: Infinity })).toBe('closeKeyboard');
    // Open wins over any window.
    expect(keyboardBackAction({ keyboardVisible: true, msSinceKeyboardHid: 100 })).toBe('closeKeyboard');
    expect(keyboardBackAction({ keyboardVisible: false, msSinceKeyboardHid: 0 })).toBe('swallow');
    expect(keyboardBackAction({ keyboardVisible: false, msSinceKeyboardHid: 100 })).toBe('swallow');
    expect(keyboardBackAction({ keyboardVisible: false, msSinceKeyboardHid: KEYBOARD_BACK_GRACE_MS - 1 })).toBe('swallow');
    expect(keyboardBackAction({ keyboardVisible: false, msSinceKeyboardHid: KEYBOARD_BACK_GRACE_MS })).toBe('pass');
    expect(keyboardBackAction({ keyboardVisible: false, msSinceKeyboardHid: 600 })).toBe('pass');
    expect(keyboardBackAction({ keyboardVisible: false, msSinceKeyboardHid: Infinity })).toBe('pass');
    // The clock went back since the hide: not "just now".
    expect(keyboardBackAction({ keyboardVisible: false, msSinceKeyboardHid: -3000 })).toBe('pass');
  });

  test('hideOpensGrace: a hide the app asked for (< 1 s ago) is never a Back press', () => {
    expect(SELF_DISMISS_MS).toBe(1000);
    expect(hideOpensGrace(Infinity)).toBe(true);
    expect(hideOpensGrace(0)).toBe(false);
    expect(hideOpensGrace(300)).toBe(false);
    expect(hideOpensGrace(SELF_DISMISS_MS - 1)).toBe(false);
    expect(hideOpensGrace(SELF_DISMISS_MS)).toBe(true);
    expect(hideOpensGrace(-300)).toBe(true); // the clock went back
  });

  test('withinMs: 0 ≤ ms < window; a negative value is never inside', () => {
    expect(withinMs(0, 500)).toBe(true);
    expect(withinMs(80, 500)).toBe(true);
    expect(withinMs(500, 500)).toBe(false);
    expect(withinMs(Infinity, 500)).toBe(false);
    expect(withinMs(-1, 500)).toBe(false);
  });

  test('steadyTime never goes back', () => {
    const a = steadyTime();
    const b = steadyTime();
    expect(typeof a).toBe('number');
    expect(b).toBeGreaterThanOrEqual(a);
  });
});

/* ================================================================ 2. the installed guard */

describe('the guard on every Back listener', () => {
  test('keyboard open: the listener is NOT called, the keyboard closes, the press is taken', () => {
    const { backHandler, keyboard } = phone();
    const navigator = goesBack();
    backHandler.addEventListener('hardwareBackPress', navigator);
    keyboard.open();
    expect(backHandler.press()).toBe(true);
    expect(navigator).not.toHaveBeenCalled();
    expect(keyboard.dismissed).toHaveBeenCalledTimes(1);
  });

  test('the keyboard closed by itself 100 ms ago: that press is taken ONCE, the next press goes back', () => {
    const { backHandler, keyboard } = phone();
    const navigator = goesBack();
    backHandler.addEventListener('hardwareBackPress', navigator);
    keyboard.open();
    keyboard.didHide(); // Android closed it on the Back press, before the app heard the press
    advance(100);
    expect(backHandler.press()).toBe(true);
    expect(navigator).not.toHaveBeenCalled();
    // The window is used up: the next press, even at once, is a real Back.
    expect(backHandler.press()).toBe(true);
    expect(navigator).toHaveBeenCalledTimes(1);
  });

  test('the keyboard closed by itself 600 ms ago: the press goes back', () => {
    const { backHandler, keyboard } = phone();
    const navigator = goesBack();
    backHandler.addEventListener('hardwareBackPress', navigator);
    keyboard.open();
    keyboard.didHide();
    advance(600);
    expect(backHandler.press()).toBe(true);
    expect(navigator).toHaveBeenCalledTimes(1);
    expect(keyboard.dismissed).not.toHaveBeenCalled();
  });

  test('no keyboard: every listener runs as before (newest first, an older one when the newer returns false)', () => {
    const { backHandler } = phone();
    const navigator = goesBack();
    const screen = jest.fn<BackPressHandler>(() => false);
    backHandler.addEventListener('hardwareBackPress', navigator);
    backHandler.addEventListener('hardwareBackPress', screen);
    expect(backHandler.press()).toBe(true);
    expect(screen).toHaveBeenCalledTimes(1);
    expect(navigator).toHaveBeenCalledTimes(1);
    // Nobody takes it: false (Android would leave the app), as without the guard.
    const lone = phone().backHandler;
    lone.addEventListener('hardwareBackPress', () => false);
    expect(lone.press()).toBe(false);
  });

  test('a listener added AFTER the install is guarded; one added BEFORE is not', () => {
    const backHandler = fakeBackHandler();
    const keyboard = fakeKeyboard();
    const before = goesBack();
    backHandler.addEventListener('hardwareBackPress', before);
    install = installKeyboardBackGuard({ backHandler, keyboard, now });
    keyboard.open();
    // Only the old listener: it is asked as before (that is why _layout.tsx installs at module load).
    expect(backHandler.press()).toBe(true);
    expect(before).toHaveBeenCalledTimes(1);
    const after = goesBack();
    backHandler.addEventListener('hardwareBackPress', after);
    expect(backHandler.press()).toBe(true);
    expect(after).not.toHaveBeenCalled();
    expect(before).toHaveBeenCalledTimes(1);
    expect(keyboard.dismissed).toHaveBeenCalledTimes(1);
  });

  test('remove() of a guarded listener really removes it', () => {
    const { backHandler } = phone();
    const screen = goesBack();
    const sub = backHandler.addEventListener('hardwareBackPress', screen);
    expect(backHandler.size()).toBe(1);
    sub.remove();
    expect(backHandler.size()).toBe(0);
    expect(backHandler.press()).toBe(false);
    expect(screen).not.toHaveBeenCalled();
  });

  test('React Native’s rule stays: the same handler added twice is stored once, and one remove() removes it', () => {
    const { backHandler } = phone();
    const screen = goesBack();
    backHandler.addEventListener('hardwareBackPress', screen);
    const sub = backHandler.addEventListener('hardwareBackPress', screen);
    expect(backHandler.size()).toBe(1);
    sub.remove();
    expect(backHandler.size()).toBe(0);
    // Added again later: guarded again.
    backHandler.addEventListener('hardwareBackPress', screen);
    expect(backHandler.size()).toBe(1);
  });

  test('the guard’s own close never takes the next press: Back, the hide it asked for, Back → goes back', () => {
    const { backHandler, keyboard } = phone();
    const navigator = goesBack();
    backHandler.addEventListener('hardwareBackPress', navigator);
    keyboard.open();
    expect(backHandler.press()).toBe(true); // closes the keyboard only
    advance(250);
    keyboard.didHide(); // the hide the guard asked for
    advance(10);
    expect(backHandler.press()).toBe(true);
    expect(navigator).toHaveBeenCalledTimes(1);
  });

  test('the app closes the keyboard itself ("Check"): its hide never takes a Back press; it explains ONE hide only', () => {
    const { backHandler, keyboard } = phone();
    const navigator = goesBack();
    backHandler.addEventListener('hardwareBackPress', navigator);
    keyboard.open();
    markAppClosesKeyboard();
    keyboard.didHide();
    expect(backHandler.press()).toBe(true);
    expect(navigator).toHaveBeenCalledTimes(1);
    // A later hide by itself opens the window again.
    keyboard.open();
    keyboard.didHide();
    expect(backHandler.press()).toBe(true);
    expect(navigator).toHaveBeenCalledTimes(1);
    // A mark while the keyboard is ALREADY closed waits for no hide: the next hide by itself still counts.
    markAppClosesKeyboard();
    keyboard.open();
    keyboard.didHide();
    expect(backHandler.press()).toBe(true);
    expect(navigator).toHaveBeenCalledTimes(1);
  });

  // Review round 1: the Settings search closes the keyboard itself when a
  // result row opens a page (Keyboard.dismiss()), and its hide came ~250 ms
  // later. Without the wrapper that hide opened the window, and a Back press
  // just after it (a wrong row) only did nothing.
  test('any Keyboard.dismiss() of the app (a Settings result row): its hide never takes the next Back press', () => {
    const { backHandler, keyboard } = phone();
    const navigator = goesBack();
    backHandler.addEventListener('hardwareBackPress', navigator);
    keyboard.open();
    keyboard.dismiss(); // the row closes the keyboard, then opens a page
    expect(keyboard.dismissed).toHaveBeenCalledTimes(1); // the keyboard's own dismiss still runs
    advance(250);
    keyboard.didHide(); // the hide that dismiss() asked for
    advance(10);
    expect(backHandler.press()).toBe(true);
    expect(navigator).toHaveBeenCalledTimes(1); // a real Back at once
    // Passed on its own (`onSubmitEditing={Keyboard.dismiss}`, no `this`): the same.
    const dismiss = keyboard.dismiss;
    keyboard.open();
    dismiss();
    keyboard.didHide();
    expect(backHandler.press()).toBe(true);
    expect(navigator).toHaveBeenCalledTimes(2);
    expect(keyboard.dismissed).toHaveBeenCalledTimes(2);
    // It explains ONE hide only: a later hide by itself opens the window again.
    keyboard.open();
    keyboard.didHide();
    expect(backHandler.press()).toBe(true);
    expect(navigator).toHaveBeenCalledTimes(2);
    // A dismiss() while the keyboard is ALREADY closed waits for no hide: the next hide by itself still counts.
    keyboard.dismiss();
    keyboard.open();
    keyboard.didHide();
    expect(backHandler.press()).toBe(true);
    expect(navigator).toHaveBeenCalledTimes(2);
  });

  test('a Sheet over the page: after an app dismiss() and its hide, the first Back closes the sheet', () => {
    const { keyboard } = phone();
    keyboard.open();
    keyboard.dismiss();
    keyboard.didHide();
    // What Sheet.onRequestClose asks: not the keyboard's press, so the sheet closes.
    expect(backPressClosesKeyboard()).toBe(false);
  });

  test('React Native’s Keyboard (dismiss is a method of its class): the install wraps it, uninstall shows the class method again', () => {
    /** Like React Native's KeyboardImpl: `dismiss` lives on the class, not on the object. */
    class ClassKeyboard {
      visible = false;
      closes = 0;
      isVisible(): boolean {
        return this.visible;
      }
      dismiss(): void {
        this.closes += 1; // uses `this`: the wrapper must call it on the keyboard
      }
      addListener(_eventName: 'keyboardDidHide', _listener: () => void): { remove(): void } {
        return { remove: () => undefined };
      }
    }
    const keyboard = new ClassKeyboard();
    const backHandler = fakeBackHandler();
    install = installKeyboardBackGuard({ backHandler, keyboard, now });
    expect(Object.prototype.hasOwnProperty.call(keyboard, 'dismiss')).toBe(true);
    const dismiss = keyboard.dismiss;
    dismiss(); // no `this`
    expect(keyboard.closes).toBe(1);
    install.uninstall();
    install = null;
    expect(Object.prototype.hasOwnProperty.call(keyboard, 'dismiss')).toBe(false);
    expect(keyboard.dismiss).toBe(ClassKeyboard.prototype.dismiss);
  });

  test('the newest hide decides; a clock that went back never keeps the window open', () => {
    const { backHandler, keyboard } = phone();
    const navigator = goesBack();
    backHandler.addEventListener('hardwareBackPress', navigator);
    keyboard.open();
    keyboard.didHide(); // by itself: the window opens
    keyboard.open();
    markAppClosesKeyboard();
    keyboard.didHide(); // the app's close: the window of the older hide is closed too
    expect(backHandler.press()).toBe(true);
    expect(navigator).toHaveBeenCalledTimes(1);
    keyboard.open();
    keyboard.didHide();
    advance(-3000); // the clock went back
    expect(backHandler.press()).toBe(true);
    expect(navigator).toHaveBeenCalledTimes(2);
  });

  test('a listener that handles the keyboard itself (the session) is not guarded, and its marks keep the guard in step', () => {
    const { backHandler, keyboard } = phone();
    const navigator = goesBack();
    backHandler.addEventListener('hardwareBackPress', navigator);
    // The session's own rule, in short: open → close it itself; else pass the press on (nothing rated).
    const session = jest.fn<BackPressHandler>(() => {
      const open = keyboard.isVisible();
      if (!open) return false;
      markKeyboardBackPress(open);
      keyboard.dismiss();
      return true;
    });
    addKeyboardAwareBackListener(backHandler, session);
    keyboard.open();
    expect(backHandler.press()).toBe(true);
    expect(session).toHaveBeenCalledTimes(1); // asked: the guard did not run before it
    expect(navigator).not.toHaveBeenCalled();
    keyboard.didHide(); // the hide the session asked for
    expect(backHandler.press()).toBe(true);
    expect(navigator).toHaveBeenCalledTimes(1); // the guard did not take this press again
    // The window case: the session took the press of a keyboard that closed by itself.
    keyboard.open();
    keyboard.didHide();
    markKeyboardBackPress(false);
    expect(backHandler.press()).toBe(true);
    expect(navigator).toHaveBeenCalledTimes(2);
  });

  test('without an install everything is a no-op, and a keyboard-aware listener is a normal listener', () => {
    const backHandler = fakeBackHandler();
    const screen = goesBack();
    addKeyboardAwareBackListener(backHandler, screen);
    expect(backHandler.size()).toBe(1);
    expect(backHandler.press()).toBe(true);
    expect(backPressClosesKeyboard()).toBe(false);
    expect(() => {
      markAppClosesKeyboard();
      markKeyboardBackPress(true);
    }).not.toThrow();
  });

  test('installed twice on the same BackHandler: one guard, one wrapper; uninstall puts it all back', () => {
    const backHandler = fakeBackHandler();
    const keyboard = fakeKeyboard();
    const plainAdd = backHandler.addEventListener;
    const plainDismiss = keyboard.dismiss;
    install = installKeyboardBackGuard({ backHandler, keyboard, now });
    const wrapped = backHandler.addEventListener;
    const wrappedDismiss = keyboard.dismiss;
    expect(wrappedDismiss).not.toBe(plainDismiss);
    expect(installKeyboardBackGuard({ backHandler, keyboard, now })).toBe(install);
    expect(backHandler.addEventListener).toBe(wrapped);
    expect(keyboard.dismiss).toBe(wrappedDismiss);
    expect(keyboard.hideListeners()).toBe(1);
    backHandler.addEventListener('hardwareBackPress', goesBack());
    keyboard.open();
    expect(backHandler.press()).toBe(true);
    expect(keyboard.dismissed).toHaveBeenCalledTimes(1); // asked once, not twice
    install.uninstall();
    install = null;
    expect(backHandler.addEventListener).toBe(plainAdd);
    expect(keyboard.dismiss).toBe(plainDismiss);
    expect(keyboard.hideListeners()).toBe(0);
    expect(backPressClosesKeyboard()).toBe(false);
  });

  test('another Keyboard on the same BackHandler: the old install is replaced, never wrapped twice', () => {
    const backHandler = fakeBackHandler();
    const plainAdd = backHandler.addEventListener;
    const first = fakeKeyboard();
    const firstDismiss = first.dismiss;
    installKeyboardBackGuard({ backHandler, keyboard: first, now });
    const keyboard = fakeKeyboard();
    install = installKeyboardBackGuard({ backHandler, keyboard, now });
    expect(first.hideListeners()).toBe(0); // the old install is gone
    expect(first.dismiss).toBe(firstDismiss);
    const navigator = goesBack();
    backHandler.addEventListener('hardwareBackPress', navigator);
    keyboard.open();
    expect(backHandler.press()).toBe(true);
    expect(navigator).not.toHaveBeenCalled();
    expect(keyboard.dismissed).toHaveBeenCalledTimes(1);
    install.uninstall();
    install = null;
    expect(backHandler.addEventListener).toBe(plainAdd);
  });

  test('a second copy of this module (a Fast Refresh in development) wraps the ORIGINAL, never the old wrapper', () => {
    const backHandler = fakeBackHandler();
    const keyboard = fakeKeyboard();
    const plainAdd = backHandler.addEventListener;
    const plainDismiss = keyboard.dismiss;
    install = installKeyboardBackGuard({ backHandler, keyboard, now }); // the old copy
    const fresh: { copy?: typeof import('./keyboardBack') } = {};
    jest.isolateModules(() => {
      fresh.copy = jest.requireActual<typeof import('./keyboardBack')>('./keyboardBack');
    });
    const second = fresh.copy!.installKeyboardBackGuard({ backHandler, keyboard, now });
    const navigator = goesBack();
    backHandler.addEventListener('hardwareBackPress', navigator);
    keyboard.open();
    keyboard.didHide(); // both copies hear the hide (both listen)
    expect(backHandler.press()).toBe(true); // the press that closed the keyboard
    // ONE guard asks: two nested guards would each take one press here.
    expect(backHandler.press()).toBe(true);
    expect(navigator).toHaveBeenCalledTimes(1);
    // The dismiss is wrapped ONCE too: one app close runs the keyboard's own dismiss once.
    keyboard.dismiss();
    expect(keyboard.dismissed).toHaveBeenCalledTimes(2);
    second.uninstall();
    expect(backHandler.addEventListener).toBe(plainAdd);
    expect(keyboard.dismiss).toBe(plainDismiss);
  });

  test('createKeyboardBackGuard alone: the memory and the decision, with no global effect', () => {
    const keyboard = fakeKeyboard();
    const guard = createKeyboardBackGuard(keyboard, now);
    expect(guard.handleBackPress()).toBe(false);
    keyboard.open();
    keyboard.didHide(); // nobody listens: the guard is not told
    expect(guard.handleBackPress()).toBe(false);
    guard.onKeyboardDidHide();
    expect(guard.handleBackPress()).toBe(true);
    expect(guard.handleBackPress()).toBe(false);
    expect(backPressClosesKeyboard()).toBe(false); // nothing installed
  });
});

/* ================================================================ 3. Sheet (a Modal) */

describe('Sheet: Android’s Back with the keyboard open', () => {
  function renderSheet(onClose: () => void): ReactTestRenderer {
    jest.useFakeTimers();
    act(() => {
      renderer = TestRenderer.create(h(Sheet, { open: true, onClose, title: 'Save as list', children: h(Text, null, 'body') }));
    });
    return renderer!;
  }
  /** Android's Back on the sheet: React Native calls the Modal's onRequestClose. */
  const backOnSheet = (r: ReactTestRenderer) => act(() => r.root.findByType(Modal).props.onRequestClose());

  test('the first press closes only the keyboard; the next press closes the sheet', () => {
    const { keyboard } = phone();
    const onClose = jest.fn<() => void>();
    const r = renderSheet(onClose);
    keyboard.open();
    backOnSheet(r);
    expect(onClose).not.toHaveBeenCalled();
    expect(keyboard.dismissed).toHaveBeenCalledTimes(1);
    keyboard.didHide(); // the hide the guard asked for
    backOnSheet(r);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('the keyboard closed by itself on that press: the sheet stays; the next press closes it', () => {
    const { keyboard } = phone();
    const onClose = jest.fn<() => void>();
    const r = renderSheet(onClose);
    keyboard.open();
    keyboard.didHide();
    advance(80);
    backOnSheet(r);
    expect(onClose).not.toHaveBeenCalled();
    backOnSheet(r);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('no keyboard (or no guard, iOS): Back closes the sheet at once, as before', () => {
    const onClose = jest.fn<() => void>();
    const r = renderSheet(onClose);
    backOnSheet(r); // no install
    expect(onClose).toHaveBeenCalledTimes(1);
    phone();
    backOnSheet(r); // installed, keyboard closed
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
