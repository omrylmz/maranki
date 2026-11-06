/**
 * Tests for haptics (spec §6.9, unit W1-6): the Android pattern for each moment
 * on new AND old Android versions, and that `haptics()` sends that pattern.
 *
 * WHY the old versions matter: expo-haptics REJECTS a pattern that the phone's
 * Android does not have (Confirm/Reject need API level 30, Segment_Tick needs
 * 34), and `haptics()` ignores errors. So without a fallback an Android 10
 * phone would never vibrate, and nobody would see why.
 */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

import { androidHapticFor, haptics, HapticKind } from './haptics';

// Keep the real enums (AndroidHaptics, ImpactFeedbackStyle, …); replace only
// the calls that reach the native module, so a test can see what was sent.
jest.mock('expo-haptics', () => {
  const actual = jest.requireActual<typeof import('expo-haptics')>('expo-haptics');
  return {
    ...actual,
    performAndroidHapticsAsync: jest.fn(() => Promise.resolve()),
    selectionAsync: jest.fn(() => Promise.resolve()),
    impactAsync: jest.fn(() => Promise.resolve()),
    notificationAsync: jest.fn(() => Promise.resolve()),
  };
});

const A = Haptics.AndroidHaptics;
const KINDS: HapticKind[] = ['tick', 'rate', 'again', 'complete'];

/**
 * The patterns that expo-haptics 56 can play on EVERY Android version (the
 * fallback list in its android/…/HapticsRecord.kt). Any other pattern is
 * rejected on a phone that is too old for it.
 */
const ALWAYS_AVAILABLE = [A.Clock_Tick, A.Context_Click, A.Keyboard_Tap, A.Long_Press, A.Virtual_Key];

describe('androidHapticFor', () => {
  test('Android 14+ (API 34): exactly the spec §6.9 patterns', () => {
    for (const apiLevel of [34, 35, 36]) {
      expect(androidHapticFor('tick', apiLevel)).toBe(A.Segment_Tick);
      expect(androidHapticFor('rate', apiLevel)).toBe(A.Confirm);
      expect(androidHapticFor('again', apiLevel)).toBe(A.Reject);
      expect(androidHapticFor('complete', apiLevel)).toBe(A.Confirm);
    }
  });

  test('Android 11–13 (API 30–33): Confirm and Reject, but no Segment_Tick yet', () => {
    for (const apiLevel of [30, 31, 32, 33]) {
      expect(androidHapticFor('tick', apiLevel)).toBe(A.Clock_Tick);
      expect(androidHapticFor('rate', apiLevel)).toBe(A.Confirm);
      expect(androidHapticFor('again', apiLevel)).toBe(A.Reject);
      expect(androidHapticFor('complete', apiLevel)).toBe(A.Confirm);
    }
  });

  test('Android 7–10 (API 24–29): only patterns that every Android has', () => {
    for (const apiLevel of [24, 26, 29]) {
      expect(androidHapticFor('tick', apiLevel)).toBe(A.Clock_Tick);
      expect(androidHapticFor('rate', apiLevel)).toBe(A.Virtual_Key);
      expect(androidHapticFor('again', apiLevel)).toBe(A.Long_Press);
      expect(androidHapticFor('complete', apiLevel)).toBe(A.Virtual_Key);
    }
  });

  test('"Again" still feels different from the other ratings on an old phone', () => {
    expect(androidHapticFor('again', 29)).not.toBe(androidHapticFor('rate', 29));
  });

  test('an unknown API level gets a pattern that works everywhere', () => {
    for (const kind of KINDS) {
      expect(ALWAYS_AVAILABLE).toContain(androidHapticFor(kind, Number.NaN));
      expect(ALWAYS_AVAILABLE).toContain(androidHapticFor(kind, 0));
    }
  });

  test('below API 30 every moment uses a pattern from the always-available list', () => {
    for (let apiLevel = 24; apiLevel < 30; apiLevel++) {
      for (const kind of KINDS) {
        expect(ALWAYS_AVAILABLE).toContain(androidHapticFor(kind, apiLevel));
      }
    }
  });
});

describe('haptics()', () => {
  const perform = jest.mocked(Haptics.performAndroidHapticsAsync);
  const selection = jest.mocked(Haptics.selectionAsync);

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  /** Pretend the test runs on an Android phone with this API level. */
  function onAndroid(apiLevel: number): void {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'Version', 'get').mockReturnValue(apiLevel);
  }

  test('Android 10 (API 29): sends the old pattern, not one the phone rejects', () => {
    onAndroid(29);
    haptics('rate', true);
    haptics('again', true);
    haptics('tick', true);
    expect(perform.mock.calls).toEqual([[A.Virtual_Key], [A.Long_Press], [A.Clock_Tick]]);
  });

  test('Android 14 (API 34): sends the spec §6.9 pattern', () => {
    onAndroid(34);
    haptics('tick', true);
    haptics('complete', true);
    expect(perform.mock.calls).toEqual([[A.Segment_Tick], [A.Confirm]]);
  });

  test('the Haptics setting off → nothing is sent', () => {
    onAndroid(34);
    haptics('rate', false);
    expect(perform).not.toHaveBeenCalled();
  });

  test('iOS uses the iOS calls, never the Android one', () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    haptics('tick', true);
    expect(selection).toHaveBeenCalledTimes(1);
    expect(perform).not.toHaveBeenCalled();
  });

  test('a rejected native call does not throw (fire and forget)', async () => {
    onAndroid(29);
    perform.mockImplementationOnce(() => Promise.reject(new Error('not supported')));
    expect(() => haptics('rate', true)).not.toThrow();
    // Let the rejected promise settle: an unhandled rejection would fail the test run.
    await Promise.resolve();
  });
});
