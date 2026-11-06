/**
 * Haptics — small vibrations that confirm a touch (spec §6.9).
 *
 * One call for every moment: `haptics(kind, settings.hapticsEnabled)`. The
 * `enabled` argument is the user's "Haptics" setting; when it is off, nothing
 * happens. Not wired to screens yet (wave 4 calls it).
 *
 * iOS and Android use different APIs on purpose. The expo-haptics docs (SDK 56)
 * recommend `performAndroidHapticsAsync` on Android: it uses the system's own
 * haptic patterns and needs no VIBRATE permission, while `impactAsync` /
 * `notificationAsync` only imitate them with the older Vibrator API there.
 * On web (the dev preview) and other platforms it does nothing.
 *
 * Android versions: the §6.9 patterns are NEW in Android. `Confirm` and
 * `Reject` exist from Android 11 (API level 30), `Segment_Tick` from Android 14
 * (API level 34). On an older phone the native module cannot find the pattern
 * and REJECTS the call, so nothing would vibrate (and no one would see an
 * error, because errors are ignored here). So `androidHapticFor()` picks an
 * older pattern that every Android version has (Android 7, API level 24, is
 * the oldest one this app supports).
 *
 * A haptic must never break the screen: the call returns at once ("fire and
 * forget"), and an error from the native module is ignored (for example on a
 * phone without a vibration motor, or with iOS Low Power Mode on).
 *
 * Example:
 *   haptics('again', settings.hapticsEnabled);   // the learner rated "Again"
 */
import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

/**
 * The moments that vibrate (spec §6.9):
 *   - 'tick'     — reveal the answer, a triage choice, a chip toggle
 *   - 'rate'     — rate Hard, Good or Easy
 *   - 'again'    — rate Again
 *   - 'complete' — the session is complete
 */
export type HapticKind = 'tick' | 'rate' | 'again' | 'complete';

/** iOS: one expo-haptics call per moment (spec §6.9, iOS column). */
const IOS: Record<HapticKind, () => Promise<void>> = {
  tick: () => Haptics.selectionAsync(),
  rate: () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light),
  again: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning),
  complete: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
};

/** One Android moment: the §6.9 pattern, and what to use on an older phone. */
interface AndroidChoice {
  /** The spec §6.9 pattern (Android column). */
  best: Haptics.AndroidHaptics;
  /** The first Android API level that has `best`. */
  since: number;
  /**
   * Used below `since`. It must be one of the patterns that expo-haptics can
   * play on EVERY Android version: Clock_Tick, Context_Click, Keyboard_Tap,
   * Long_Press or Virtual_Key (the fallback list in its HapticsRecord.kt).
   */
  fallback: Haptics.AndroidHaptics;
}

/** Android: one system haptic pattern per moment (spec §6.9, Android column). */
const ANDROID_HAPTICS: Record<HapticKind, AndroidChoice> = {
  // A light tick. Clock_Tick is the closest old pattern.
  tick: { best: Haptics.AndroidHaptics.Segment_Tick, since: 34, fallback: Haptics.AndroidHaptics.Clock_Tick },
  // A short, clear tap.
  rate: { best: Haptics.AndroidHaptics.Confirm, since: 30, fallback: Haptics.AndroidHaptics.Virtual_Key },
  // A longer, heavier buzz, so "Again" feels different from the other ratings.
  again: { best: Haptics.AndroidHaptics.Reject, since: 30, fallback: Haptics.AndroidHaptics.Long_Press },
  complete: { best: Haptics.AndroidHaptics.Confirm, since: 30, fallback: Haptics.AndroidHaptics.Virtual_Key },
};

/**
 * The Android pattern for `kind` on a phone with this API level (PURE).
 * `apiLevel` is `Platform.Version` on Android, for example 34 for Android 14.
 * A value that is not a number (it should never happen) counts as an old phone,
 * because the fallback pattern works everywhere.
 *
 * Example:
 *   androidHapticFor('tick', 34)  // → AndroidHaptics.Segment_Tick
 *   androidHapticFor('tick', 29)  // → AndroidHaptics.Clock_Tick
 */
export function androidHapticFor(kind: HapticKind, apiLevel: number): Haptics.AndroidHaptics {
  const choice = ANDROID_HAPTICS[kind];
  return apiLevel >= choice.since ? choice.best : choice.fallback;
}

/** The Android API level of this phone. `Platform.Version` is a number on Android. */
function androidApiLevel(): number {
  const version = Platform.Version;
  return typeof version === 'number' ? version : Number.NaN;
}

/** Vibrate for `kind`, when the user's Haptics setting (`enabled`) is on. */
export function haptics(kind: HapticKind, enabled: boolean): void {
  if (!enabled) return;
  let pending: Promise<void>;
  try {
    if (Platform.OS === 'ios') {
      pending = IOS[kind]();
    } else if (Platform.OS === 'android') {
      pending = Haptics.performAndroidHapticsAsync(androidHapticFor(kind, androidApiLevel()));
    } else {
      return;
    }
  } catch {
    return; // the native module is missing (for example in an old dev build)
  }
  pending.catch(() => {
    // Ignored on purpose: a failed vibration is not worth a message.
  });
}
