/**
 * The AnkiWeb tab of the import's Source stage (SourceStage.tsx), rendered
 * with react-test-renderer:
 *   - a search that FAILED (offline) says so and offers "Try again" — it is
 *     never shown as "No shared decks match" under "Popular decks";
 *   - "Try again" runs the same search again, and its results replace the error;
 *   - a search with no results still says "No shared decks match".
 *
 * Module mocks: ThemeContext (the light palette), vector icons (render
 * nothing), and `searchSharedDecks` (each test says what it answers).
 */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import React from 'react';
import { BackHandler, Text } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { AnkiWebError, type AnkiWebDeck } from '../../domain/ankiweb';
import { ANKIWEB_SEARCH_FAILED, SourceStage } from './SourceStage';

jest.mock('../../theme/ThemeContext', () => ({
  useColors: () => jest.requireActual<typeof import('../../theme/tokens')>('../../theme/tokens').light,
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

const mockSearch = jest.fn<(query: string, signal?: AbortSignal) => Promise<AnkiWebDeck[]>>();
jest.mock('../../domain/ankiweb', () => {
  const actual = jest.requireActual<typeof import('../../domain/ankiweb')>('../../domain/ankiweb');
  return { ...actual, searchSharedDecks: (query: string, signal?: AbortSignal) => mockSearch(query, signal) };
});

const h = React.createElement;
let renderer: ReactTestRenderer | null = null;

/** Android's back stack of handlers (the iOS BackHandler under jest does nothing): the last one added is asked first. */
let backHandlers: (() => boolean | null | undefined)[] = [];
/** Press Android's back: true when a handler took it (else the screen would close). */
function pressBack(): boolean {
  for (const handler of [...backHandlers].reverse()) if (handler()) return true;
  return false;
}

beforeEach(() => {
  jest.useFakeTimers();
  mockSearch.mockReset();
  backHandlers = [];
  jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_event, handler) => {
    backHandlers.push(handler);
    return {
      remove: () => {
        backHandlers = backHandlers.filter((x) => x !== handler);
      },
    };
  });
});

afterEach(() => {
  if (renderer) act(() => renderer!.unmount());
  renderer = null;
  jest.useRealTimers();
  jest.restoreAllMocks();
});

function renderStage(): ReactTestRenderer {
  act(() => {
    renderer = TestRenderer.create(
      h(SourceStage, {
        tab: 'ankiweb',
        onTab: () => undefined,
        fileBusy: false,
        onChooseFile: () => undefined,
        onDownload: () => undefined,
        restore: { busy: false, pickFile: () => undefined },
      }),
    );
  });
  return renderer!;
}

/** Every text on screen, joined. */
function screenText(r: ReactTestRenderer): string {
  return r.root
    .findAllByType(Text)
    .map((t) => [t.props.children].flat().filter((x) => typeof x === 'string' || typeof x === 'number').join(''))
    .join(' | ');
}

/** Run the debounce timer and let the search promise settle. */
async function settle(): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(400);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

const deck = (id: string, name: string): AnkiWebDeck => ({
  id,
  name,
  notes: 10,
  audio: 0,
  images: 0,
  upvotes: 1,
  downvotes: 0,
  modifiedSec: 0,
});

describe('AnkiWeb search failure (offline) is not "no decks"', () => {
  test('a failed search shows "Could not reach AnkiWeb" and "Try again", never "No shared decks match"', async () => {
    mockSearch.mockRejectedValueOnce(new AnkiWebError('network', 'Could not reach AnkiWeb. Check your connection.'));
    const r = renderStage();
    await settle();
    const text = screenText(r);
    expect(text).toContain(ANKIWEB_SEARCH_FAILED.title);
    expect(text).toContain(ANKIWEB_SEARCH_FAILED.fallback);
    expect(text).not.toContain('No shared decks match');
    expect(text).not.toContain('Popular decks');
    const retry = r.root.find(
      (n) => typeof n.type !== 'string' && n.props.accessibilityLabel === ANKIWEB_SEARCH_FAILED.retry && 'onPress' in n.props,
    );

    // "Try again" runs the SAME search again; its results replace the error.
    mockSearch.mockResolvedValueOnce([deck('1', 'German A1')]);
    act(() => retry.props.onPress());
    await settle();
    expect(mockSearch).toHaveBeenCalledTimes(2);
    expect(mockSearch.mock.calls[1][0]).toBe(mockSearch.mock.calls[0][0]);
    const after = screenText(r);
    expect(after).toContain('German A1');
    expect(after).not.toContain(ANKIWEB_SEARCH_FAILED.title);
  });

  test('a search with no results still says "No shared decks match" (no error, no Try again)', async () => {
    mockSearch.mockResolvedValueOnce([]);
    const r = renderStage();
    await settle();
    const text = screenText(r);
    expect(text).toContain('No shared decks match');
    expect(text).not.toContain(ANKIWEB_SEARCH_FAILED.title);
  });

  test("Android back on a deck's details goes back to the results, not out of Import", async () => {
    mockSearch.mockResolvedValueOnce([deck('7', 'Spanish verbs')]);
    const r = renderStage();
    await settle();
    const row = r.root.findAll(
      (n) => typeof n.type !== 'string' && typeof n.props.onPress === 'function' && screenTextOf(n).includes('Spanish verbs'),
    )[0];
    act(() => row.props.onPress());
    expect(screenText(r)).toContain('Download & preview');
    let handled = false;
    act(() => {
      handled = pressBack();
    });
    expect(handled).toBe(true);
    expect(screenText(r)).not.toContain('Download & preview');
    expect(screenText(r)).toContain('Spanish verbs');
    // On the results, back is not taken here: the screen decides (it closes Import from the source stage).
    expect(pressBack()).toBe(false);
  });
});

describe('AnkiWeb search results while a new search runs', () => {
  test('the OLD rows are hidden and the heading says "Searching AnkiWeb…" until the new results land', async () => {
    mockSearch.mockResolvedValueOnce([deck('1', 'Popular deck')]);
    const r = renderStage();
    await settle();
    expect(screenText(r)).toContain('Popular deck');
    expect(screenText(r)).toContain('Popular decks');

    // A search that does not answer yet.
    let answer: (decks: AnkiWebDeck[]) => void = () => undefined;
    mockSearch.mockImplementationOnce(() => new Promise<AnkiWebDeck[]>((resolve) => (answer = resolve)));
    const input = r.root.find((n) => n.props.accessibilityLabel === 'Search shared decks' && typeof n.props.onChangeText === 'function');
    act(() => input.props.onChangeText('german'));
    await settle();
    expect(screenText(r)).toContain('Searching AnkiWeb…');
    expect(screenText(r)).not.toContain('Popular deck');
    // No row to tap while it searches.
    expect(r.root.findAll((n) => typeof n.type !== 'string' && n.props.hint === "Shows the deck's details. Nothing is imported yet.")).toHaveLength(0);

    await act(async () => {
      answer([deck('2', 'German A1')]);
      await Promise.resolve();
    });
    expect(screenText(r)).toContain('German A1');
    expect(screenText(r)).toContain('Search results');
    expect(screenText(r)).not.toContain('Popular deck');
  });

  test("a result row's spoken label is the deck's name and facts (no icon glyph)", async () => {
    mockSearch.mockResolvedValueOnce([deck('7', 'Spanish verbs')]);
    const r = renderStage();
    await settle();
    const row = r.root.find((n) => typeof n.props.accessibilityLabel === 'string' && n.props.accessibilityLabel.startsWith('Spanish verbs, '));
    expect(row.props.accessibilityLabel).toMatch(/^Spanish verbs, \S/);
    expect(row.props.accessibilityHint).toBe("Shows the deck's details. Nothing is imported yet.");
  });
});

/** The text inside one rendered node. */
function screenTextOf(node: TestRenderer.ReactTestInstance): string {
  return node
    .findAllByType(Text)
    .map((t) => [t.props.children].flat().filter((x) => typeof x === 'string').join(''))
    .join(' ');
}
