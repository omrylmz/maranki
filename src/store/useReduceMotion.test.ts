/**
 * Tests for src/store/useReduceMotion.ts (W3-7, spec §8.12 Reduce Motion).
 *
 * The OS is React Native's jest mock of AccessibilityInfo. Each test sets
 * what `isReduceMotionEnabled()` answers, and catches the listener that the
 * module gives to `addEventListener('reduceMotionChanged', …)`, so a test
 * can "change the phone setting".
 *
 * The module keeps its state (the last value, the one OS listener) between
 * tests. So `beforeEach` brings it back to the start: it reads `false` once
 * through the module's own API and unsubscribes (no listener left), then
 * forgets the mock calls of that reset.
 */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import React from 'react';
import { AccessibilityInfo } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import * as reduceMotion from './useReduceMotion';

type Module = typeof reduceMotion;

/** The module, back at its start state (see beforeEach). */
function freshModule(): Module {
  return reduceMotion;
}

const isEnabled = jest.mocked(AccessibilityInfo.isReduceMotionEnabled);
const addListener = jest.mocked(AccessibilityInfo.addEventListener);

/** The handlers given to addEventListener, and their remove() spies. */
let osHandlers: { event: string; handler: (v: boolean) => void; remove: jest.Mock }[] = [];

beforeEach(async () => {
  osHandlers = [];
  isEnabled.mockReset();
  isEnabled.mockResolvedValue(false);
  addListener.mockReset();
  addListener.mockImplementation(((event: string, handler: (v: boolean) => void) => {
    const remove = jest.fn();
    osHandlers.push({ event, handler, remove });
    return { remove };
  }) as never);
  // Back to the start: the last value is false, nobody is subscribed.
  const stop = reduceMotion.subscribeReduceMotion(() => undefined);
  await settle();
  stop();
  expect(reduceMotion.lastReduceMotion()).toBe(false);
  osHandlers = [];
  isEnabled.mockClear();
  addListener.mockClear();
});

let renderer: ReactTestRenderer | null = null;
afterEach(() => {
  if (renderer) act(() => renderer!.unmount());
  renderer = null;
});

/** Let resolved promises run (the OS read). */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** A component that records every value it renders with. */
function makeProbe(mod: Module, seen: boolean[]) {
  return function Probe() {
    seen.push(mod.useReduceMotion());
    return null;
  };
}

describe('useReduceMotion', () => {
  test('first render: false; then the OS answer (true) arrives from the callback', async () => {
    const mod = freshModule();
    isEnabled.mockResolvedValue(true);
    const seen: boolean[] = [];
    act(() => {
      renderer = TestRenderer.create(React.createElement(makeProbe(mod, seen)));
    });
    // The effect only subscribed: no value was set during the effect itself.
    expect(seen).toEqual([false]);
    await settle();
    expect(seen.at(-1)).toBe(true);
    expect(mod.lastReduceMotion()).toBe(true);
    expect(isEnabled).toHaveBeenCalledTimes(1);
    expect(osHandlers.map((h) => h.event)).toEqual(['reduceMotionChanged']);
  });

  test('a change of the phone setting reaches every mounted component', async () => {
    const mod = freshModule();
    const a: boolean[] = [];
    const b: boolean[] = [];
    const Two = () =>
      React.createElement(React.Fragment, null, React.createElement(makeProbe(mod, a)), React.createElement(makeProbe(mod, b)));
    act(() => {
      renderer = TestRenderer.create(React.createElement(Two));
    });
    await settle();
    expect([a.at(-1), b.at(-1)]).toEqual([false, false]);
    // ONE OS listener for both components.
    expect(osHandlers).toHaveLength(1);

    act(() => osHandlers[0].handler(true));
    expect([a.at(-1), b.at(-1)]).toEqual([true, true]);
    act(() => osHandlers[0].handler(false));
    expect([a.at(-1), b.at(-1)]).toEqual([false, false]);
  });

  test('a component mounted later starts with the known value (no animate-then-stop)', async () => {
    const mod = freshModule();
    isEnabled.mockResolvedValue(true);
    const first: boolean[] = [];
    act(() => {
      renderer = TestRenderer.create(React.createElement(makeProbe(mod, first)));
    });
    await settle();
    const later: boolean[] = [];
    let second: ReactTestRenderer | null = null;
    act(() => {
      second = TestRenderer.create(React.createElement(makeProbe(mod, later)));
    });
    expect(later[0]).toBe(true);
    await settle(); // the second component's own read answers (true again)
    expect(later.every((v) => v === true)).toBe(true);
    act(() => second!.unmount());
  });

  test('the OS listener is removed when the last component unmounts, and added again later', async () => {
    const mod = freshModule();
    const seen: boolean[] = [];
    act(() => {
      renderer = TestRenderer.create(React.createElement(makeProbe(mod, seen)));
    });
    await settle();
    expect(osHandlers).toHaveLength(1);
    act(() => renderer!.unmount());
    renderer = null;
    expect(osHandlers[0].remove).toHaveBeenCalledTimes(1);

    const stop = mod.subscribeReduceMotion(() => undefined);
    expect(osHandlers).toHaveLength(2);
    stop();
    await settle();
    expect(osHandlers[1].remove).toHaveBeenCalledTimes(1);
  });

  test('a failed OS read keeps motion on and does not throw', async () => {
    const mod = freshModule();
    isEnabled.mockRejectedValue(new Error('no such API'));
    const seen: boolean[] = [];
    act(() => {
      renderer = TestRenderer.create(React.createElement(makeProbe(mod, seen)));
    });
    await settle();
    expect(seen.every((v) => v === false)).toBe(true);
    expect(mod.lastReduceMotion()).toBe(false);
  });

  test('subscribers that join while a read is in flight share it', async () => {
    const mod = freshModule();
    let answer: (v: boolean) => void = () => undefined;
    isEnabled.mockImplementation(() => new Promise<boolean>((resolve) => (answer = resolve)));
    const got: boolean[] = [];
    const stopA = mod.subscribeReduceMotion((v) => got.push(v));
    const stopB = mod.subscribeReduceMotion((v) => got.push(v));
    expect(isEnabled).toHaveBeenCalledTimes(1);
    answer(true);
    await settle();
    expect(got).toEqual([true, true]);
    stopA();
    stopB();
  });

  test('an unsubscribed listener hears nothing more', async () => {
    const mod = freshModule();
    const got: boolean[] = [];
    const stop = mod.subscribeReduceMotion((v) => got.push(v));
    const keep = mod.subscribeReduceMotion(() => undefined);
    await settle();
    stop();
    act(() => osHandlers[0].handler(true));
    expect(got).toEqual([false]);
    keep();
  });
});
