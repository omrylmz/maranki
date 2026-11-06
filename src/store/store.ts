/**
 * The synchronous store (spec §3.9, unit W2-1): one value, read and changed
 * at once, with listeners. No React and no other dependency.
 *
 *   const store = createStore(initialState);
 *   store.getState();                        // always the newest value
 *   store.update((s) => ({ ...s, onboarded: true }));
 *   const stop = store.subscribe(() => save(store.getState()));
 *
 * WHY: the old DataContext kept the state in React (`useState`). An action
 * then read a "mirror" ref that React updated only after the next render, so
 * the mirror could be one rating old (the M6 "stale by one rating" bug). Here
 * `getState()` returns the new value as soon as `update()` returns, so an
 * action can never read an old state.
 *
 * Rules:
 *   - `update(fn)`: `fn` gets the current value and returns the next one. It
 *     must NOT change the value it gets (in development the value is frozen,
 *     see devFreeze.ts). Returning the same object means "no change": no
 *     listener is called.
 *   - Listeners run synchronously, in the order they subscribed, after the new
 *     value is stored. A listener may call `update()` again.
 *   - React reads the store with `useSyncExternalStore(store.subscribe,
 *     store.getState)`, so `subscribe` and `getState` are plain functions
 *     (they do not need `this`).
 */

export interface Store<S> {
  /** The current value. */
  getState(): S;
  /** Replace the value with `fn(current)`. Same object back → nothing happens. */
  update(fn: (current: S) => S): void;
  /** Call `listener` after every change. Returns the function that stops it. */
  subscribe(listener: () => void): () => void;
}

export interface StoreOptions<S> {
  /**
   * Called with every new value before it is stored (and with the initial
   * value). The engine passes `deepFreeze` in development builds.
   */
  freeze?: (value: S) => S;
}

export function createStore<S>(initial: S, options: StoreOptions<S> = {}): Store<S> {
  const freeze = options.freeze ?? ((value: S) => value);
  let state = freeze(initial);
  const listeners = new Set<() => void>();

  return {
    getState: () => state,

    update: (fn) => {
      const next = fn(state);
      if (Object.is(next, state)) return;
      state = freeze(next);
      // A copy: a listener that subscribes or unsubscribes while we call
      // them does not change who is called for THIS change.
      for (const listener of [...listeners]) listener();
    },

    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
