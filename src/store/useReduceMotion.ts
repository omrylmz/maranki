/**
 * useReduceMotion() — true when the phone asks apps to show less motion
 * (iOS "Reduce Motion", Android "Remove animations"). Spec §8.12.
 *
 *   const reduced = useReduceMotion();
 *   // RiseIn renders at once, Sheet fades instead of sliding, no pulse.
 *
 * How it works:
 *   - The value lives in `useState`. The first render uses the last value
 *     read from the OS (`false` before the first read), so a list of RiseIn
 *     rows mounted later does not start an animation and stop it again.
 *   - The effect only SUBSCRIBES. It never calls `setState` itself (React
 *     Compiler lint rule: no synchronous setState in an effect body). The
 *     state changes later, from a callback: when the OS answers
 *     `AccessibilityInfo.isReduceMotionEnabled()`, or when the user changes
 *     the setting (the 'reduceMotionChanged' event).
 *   - One OS listener is shared by every component (module state), and one
 *     read is shared while it is in flight.
 *
 * `subscribeReduceMotion` and `lastReduceMotion` are exported for tests and
 * for code outside React (for example an Animated call in an event handler).
 */
import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

type Listener = (reduced: boolean) => void;

/** The last value the OS gave us. null = not read yet. */
let known: boolean | null = null;
/** The read that is in flight, shared by every new subscriber. */
let reading: Promise<void> | null = null;
/** Every mounted useReduceMotion() (and other subscribers). */
const listeners = new Set<Listener>();
/** The one OS listener, while at least one subscriber exists. */
let osSubscription: { remove(): void } | null = null;

/** Save a new value and tell every subscriber. */
function publish(value: boolean): void {
  known = value;
  for (const listener of [...listeners]) listener(value);
}

/** Ask the OS once (or join the read that is already running). */
function readFromOs(): void {
  if (reading) return;
  try {
    reading = AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => publish(value === true))
      // A failed read keeps the old value: motion stays on (the default).
      .catch(() => undefined)
      .finally(() => {
        reading = null;
      });
  } catch {
    // Some platforms (an old web build) may not have the method at all.
    reading = null;
  }
}

/** Listen to the OS setting while someone is subscribed. */
function listenToOs(): void {
  if (osSubscription) return;
  try {
    osSubscription =
      AccessibilityInfo.addEventListener('reduceMotionChanged', (value: boolean) => publish(value === true)) ??
      null;
  } catch {
    osSubscription = null;
  }
}

/**
 * The last value read from the OS, or `false` before the first read
 * (motion on, as the app always behaved).
 */
export function lastReduceMotion(): boolean {
  return known === true;
}

/**
 * Call `listener` whenever the value changes (and once when the first OS
 * read answers). Returns the unsubscribe function. Each new subscriber also
 * starts a fresh read (shared while in flight), so a value that changed
 * between a render and its effect is never missed.
 */
export function subscribeReduceMotion(listener: Listener): () => void {
  listeners.add(listener);
  listenToOs();
  readFromOs();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && osSubscription) {
      osSubscription.remove();
      osSubscription = null;
    }
  };
}

/** True while the OS asks for less motion. See the file header. */
export function useReduceMotion(): boolean {
  const [reduced, setReduced] = useState(lastReduceMotion);
  // Only a subscription here: setReduced runs later, from the callback.
  useEffect(() => subscribeReduceMotion(setReduced), []);
  return reduced;
}
