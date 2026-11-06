/**
 * The study card (StudyCard.tsx) and what a screen reader gets from it,
 * rendered with react-test-renderer — the final device pass (Android 16):
 *   - K1-2: after the reveal the card kept its FRONT label ("Card. führen.
 *     Double tap to reveal.") and could still be tapped. React Native on
 *     Android only sets a view's content description when the new label is
 *     not empty, so an `accessibilityLabel` that becomes undefined is never
 *     cleared on the phone. The fix gives the tap area a new `key` per side:
 *     after the reveal it is a NEW native view, with no label and no tap. It
 *     is also not native-clickable (`focusable` false: on Android a focusable
 *     view gets a click listener, and TalkBack read the whole answer as ONE
 *     stop) and not "disabled" (review round 1). The label also goes on
 *     More › Switch mode while the card keeps its key in the session
 *     (Flashcards → Typing before the reveal; Articles → Typing on a card
 *     with a picture): a NEW native view there too (review round 2);
 *   - K1-3: a question that ends with "?" gets no extra full stop;
 *   - K1-4: the full-screen image has an OPAQUE backdrop (the card's own
 *     image showed through a 92% black one). Since wave 5i the viewer is the
 *     shared one (src/components/ui/ImageViewer.tsx), which the CardSheet
 *     opens too; these tests still open it from the card;
 *   - C1-5 (release pass 2026-11-02): after the reveal the view that had the
 *     screen-reader focus is gone; when a screen reader is on, the focus
 *     moves to the first element of the answer side (the question line), a
 *     moment later. With no screen reader on, nothing moves. The test spies
 *     on AccessibilityInfo (the jest preset's mock) and uses fake timers;
 *   - wave 5g (review of C1-5): a question with no text (only a picture)
 *     draws NO question line on the answer side (an empty `accessible` Text
 *     was a silent TalkBack stop and took the focus); the focus goes to the
 *     first element of the answer headline instead;
 *   - wave 5g (Evening): every picture, on the card and full screen, sits on
 *     the light image well (`imageWell`), so black line art can be seen; the
 *     full-screen backdrop stays the opaque paperSunk;
 *   - wave 5h (C2 review of wave 5g): in Typing and Quiz with a picture-only
 *     question, the focus goes to the mode's result (the "You typed: …"
 *     line, the picked choice: `answerExtraFocus`), which is drawn before the
 *     answer headline and was skipped. With a question line, or no screen
 *     reader, nothing changes.
 *
 * Module mocks: ThemeContext (the light palette, or the dark one when a test
 * sets `mockTheme`), safe-area-context (zero insets), vector icons (render
 * nothing), expo-image (a plain element), and platform/media (a file uri for
 * every image).
 */
// '@jest/globals' first: the jest.mock factories below use its `jest`.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import React from 'react';
import { AccessibilityInfo, Modal, ScrollView, StyleSheet, Text, View } from 'react-native';
import TestRenderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import type { CardFace, FieldBlock, Inline } from '../../domain/model';
import { dark, light } from '../../theme/tokens';
import { CLOSE_IMAGE_LABEL, containSize, OPEN_IMAGE_HINT } from '../ui/ImageViewer';
import { focusAfterReveal, REVEAL_FOCUS_DELAY_MS, StudyCard } from './StudyCard';

/** The palette useColors() gives (a test sets 'dark' for Evening; reset after each test). */
let mockTheme: 'light' | 'dark' = 'light';
jest.mock('../../theme/ThemeContext', () => ({
  useColors: () => jest.requireActual<typeof import('../../theme/tokens')>('../../theme/tokens')[mockTheme],
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('expo-image', () => ({
  Image: function Image(props: Record<string, unknown>) {
    return jest.requireActual<typeof import('react')>('react').createElement('ExpoImage', props);
  },
}));
jest.mock('../../platform/media', () => ({
  mediaFileUri: (deckId: string, name: string) => `file:///media/${deckId}/${name}`,
}));

const h = React.createElement;
let renderer: ReactTestRenderer | null = null;

afterEach(() => {
  if (renderer) act(() => renderer!.unmount());
  renderer = null;
  mockTheme = 'light';
});

/** One field block of one line of text (and, optionally, a picture line after it). */
function block(plain: string, over: Partial<FieldBlock> = {}): FieldBlock {
  const lines: Inline[][] = plain === '' ? [] : [[{ t: 'text', text: plain }]];
  return { field: 0, label: 'Front', role: 'term', lines, plain, ...over };
}

/** A face with one question and one answer block (more answer blocks optional). */
function face(question: string, answer: FieldBlock[]): CardFace {
  return { promptPlain: question, answerPlain: answer[0]?.plain ?? '', badges: [], prompt: [block(question)], answer };
}

type CardProps = React.ComponentProps<typeof StudyCard>;

function renderCard(props: Partial<CardProps> & Pick<CardProps, 'face'>): ReactTestRenderer {
  const all: CardProps = {
    deckId: 'd1',
    revealed: false,
    step: null,
    canSpeak: false,
    genderColors: false,
    onSpeak: () => undefined,
    ...props,
  };
  act(() => {
    renderer = TestRenderer.create(h(StudyCard, all));
  });
  return renderer!;
}

/**
 * The card's tap area as a HOST view (what becomes a native view on the phone):
 * the first view inside the card's ScrollView that a Pressable draws (a
 * Pressable always passes `focusable`). On Android its `focusable` prop decides
 * whether the native view is clickable.
 */
function tapArea(r: ReactTestRenderer): ReactTestInstance {
  const hosts = r.root.findByType(ScrollView).findAll((n) => typeof n.type === 'string' && 'focusable' in n.props);
  return hosts[0];
}

/** The HOST views (what becomes a native view on the phone) with this screen-reader label. */
function hostsWithLabel(r: ReactTestRenderer, label: string): ReactTestInstance[] {
  return r.root.findAll((n) => typeof n.type === 'string' && n.props.accessibilityLabel === label);
}

describe('StudyCard: the front label never stays after the reveal (K1-2)', () => {
  const front = 'Card. führen. Double tap to reveal.';
  const f = face('führen', [block('to lead', { field: 1, label: 'Back', role: 'meaning' })]);

  test('before the reveal: one button "Card. führen. Double tap to reveal." that reveals', () => {
    const onReveal = jest.fn<() => void>();
    const r = renderCard({ face: f, onReveal });
    const hosts = hostsWithLabel(r, front);
    expect(hosts).toHaveLength(1);
    expect(hosts[0].props.accessible).toBe(true);
    expect(hosts[0].props.accessibilityRole).toBe('button');
    // The tap area itself: native-clickable (TalkBack's double tap reveals through it), enabled.
    expect(tapArea(r)).toBe(hosts[0]);
    expect(tapArea(r).props.focusable).toBe(true);
    expect(tapArea(r).props.accessibilityState?.disabled).toBe(false);
    act(() => r.root.find((n) => typeof n.type !== 'string' && n.props.accessibilityLabel === front && typeof n.props.onPress === 'function').props.onPress());
    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  test('after the reveal: the tap area is a NEW native view, with no label, no button role and no tap', () => {
    const onReveal = jest.fn<() => void>();
    const r = renderCard({ face: f, onReveal });
    const frontView = hostsWithLabel(r, front)[0];
    // The session keeps passing onReveal after the reveal (Flashcards).
    act(() => r.update(h(StudyCard, { face: f, onReveal, deckId: 'd1', revealed: true, step: null, canSpeak: false, genderColors: false, onSpeak: () => undefined })));
    // No node says the front label any more.
    expect(r.root.findAll((n) => n.props.accessibilityLabel === front)).toHaveLength(0);
    // The view that carried it is gone (unmounted), so the phone cannot keep its old description.
    expect(r.root.findAll((n) => n === frontView)).toHaveLength(0);
    // Nothing on the back is a "Card. …" button, and nothing reveals again.
    expect(r.root.findAll((n) => String(n.props.accessibilityLabel ?? '').startsWith('Card.'))).toHaveLength(0);
    expect(r.root.findAll((n) => n.props.onPress === onReveal)).toHaveLength(0);
    // The new view is not a screen-reader element, not native-clickable and not "disabled"
    // (review round 1): TalkBack reads the answer element by element, and never says "disabled".
    const back = tapArea(r);
    expect(back.props.accessible).toBe(false);
    expect(back.props.focusable).toBe(false);
    expect(back.props.accessibilityState?.disabled).not.toBe(true);
    // The back is read element by element: the answer is there as text.
    expect(r.root.findAll((n) => n.props.accessibilityLabel === 'Back: to lead' || n.props.children === 'to lead').length).toBeGreaterThan(0);
  });

  test('More › Switch mode, Flashcards → Typing before the reveal: the front label goes with a NEW native view (review round 2)', () => {
    const onReveal = jest.fn<() => void>();
    const r = renderCard({ face: f, onReveal });
    const frontView = hostsWithLabel(r, front)[0];
    expect(frontView).toBeDefined();
    // The session keeps the card's key on a mode switch (switchModeRun), so StudyCard is
    // NOT made again: only `onReveal` goes away, and `revealed` stays false.
    act(() => r.update(h(StudyCard, { face: f, deckId: 'd1', revealed: false, step: null, canSpeak: false, genderColors: false, onSpeak: () => undefined })));
    // The view that carried the front label is gone, so the phone cannot keep its old description.
    expect(r.root.findAll((n) => n === frontView)).toHaveLength(0);
    expect(r.root.findAll((n) => n.props.accessibilityLabel === front)).toHaveLength(0);
    expect(r.root.findAll((n) => n.props.onPress === onReveal)).toHaveLength(0);
    // The new tap area is not a screen-reader element and not native-clickable.
    expect(tapArea(r).props.accessible).toBe(false);
    expect(tapArea(r).props.focusable).toBe(false);
    // Typing reads the question headline as ONE element, once.
    expect(hostsWithLabel(r, 'Card. führen.')).toHaveLength(1);
  });

  test('More › Switch mode, Typing → Flashcards: the headline label goes, the card is one "tap to reveal" button', () => {
    const r = renderCard({ face: f });
    const headView = hostsWithLabel(r, 'Card. führen.')[0];
    expect(headView).toBeDefined();
    const onReveal = jest.fn<() => void>();
    act(() => r.update(h(StudyCard, { face: f, onReveal, deckId: 'd1', revealed: false, step: null, canSpeak: false, genderColors: false, onSpeak: () => undefined })));
    // The Typing headline view (with its "Card. führen." label) is gone, not only unlabelled.
    expect(r.root.findAll((n) => n === headView)).toHaveLength(0);
    expect(r.root.findAll((n) => n.props.accessibilityLabel === 'Card. führen.')).toHaveLength(0);
    const hosts = hostsWithLabel(r, front);
    expect(hosts).toHaveLength(1);
    expect(tapArea(r)).toBe(hosts[0]);
    expect(tapArea(r).props.focusable).toBe(true);
  });

  test('More › Switch mode, Articles → Typing on a card with a picture: the "Card. {word}." headline label goes with its view', () => {
    // The question headline: a line of text, then a picture (so Typing does not group it, R9).
    const pictured: CardFace = {
      promptPlain: 'der Hund',
      answerPlain: 'the dog',
      badges: [],
      prompt: [block('der Hund', { lines: [[{ t: 'text', text: 'der Hund' }], [{ t: 'img', src: 'hund.png' }]] })],
      answer: [block('the dog', { field: 1, label: 'Back', role: 'meaning' })],
    };
    const base = { face: pictured, deckId: 'd1', revealed: false, step: null, canSpeak: false, genderColors: false, onSpeak: () => undefined };
    // Articles: the session shows the bare word, and the headline is ONE element "Card. Hund.".
    const r = renderCard({ ...base, promptOverride: h('Text', null, 'Hund'), promptLabel: 'Hund' });
    const articleHead = hostsWithLabel(r, 'Card. Hund.')[0];
    expect(articleHead).toBeDefined();
    act(() => r.update(h(StudyCard, base)));
    // Typing: the old headline view is gone; only the first line of text starts the card.
    expect(r.root.findAll((n) => n === articleHead)).toHaveLength(0);
    expect(r.root.findAll((n) => n.props.accessibilityLabel === 'Card. Hund.')).toHaveLength(0);
    expect(hostsWithLabel(r, 'Card. der Hund.')).toHaveLength(1);
  });

  test('Typing (no tap to reveal): the question headline label goes with the front too', () => {
    const r = renderCard({ face: f });
    expect(hostsWithLabel(r, 'Card. führen.')).toHaveLength(1);
    // No tap on this card: the tap area is not native-clickable on either side (no empty TalkBack stop).
    expect(tapArea(r).props.focusable).toBe(false);
    expect(tapArea(r).props.accessible).toBe(false);
    act(() => r.update(h(StudyCard, { face: f, deckId: 'd1', revealed: true, step: null, canSpeak: false, genderColors: false, onSpeak: () => undefined })));
    expect(r.root.findAll((n) => String(n.props.accessibilityLabel ?? '').startsWith('Card.'))).toHaveLength(0);
    expect(tapArea(r).props.focusable).toBe(false);
  });
});

describe('StudyCard: labels (K1-3)', () => {
  test('a question that ends with "?" gets no extra full stop', () => {
    const q = face('What does a hash table store?', [block('Select items', { field: 1 })]);
    const r = renderCard({ face: q, onReveal: () => undefined });
    expect(hostsWithLabel(r, 'Card. What does a hash table store? Double tap to reveal.')).toHaveLength(1);
    expect(r.root.findAll((n) => String(n.props.accessibilityLabel ?? '').includes('?.'))).toHaveLength(0);
  });
});

describe('StudyCard: the full-screen image (K1-4)', () => {
  /** A revealed card whose answer has a picture line. */
  const pictured = face('What does a hash table store?', [
    block('Select items', { field: 1, role: 'meaning', lines: [[{ t: 'text', text: 'Select items' }], [{ t: 'img', src: 'sample.png' }]] }),
  ]);

  /** The viewer's backdrop: the full-screen "Close image" button (flex 1), as a host view. */
  function backdrop(r: ReactTestRenderer): ReactTestInstance {
    return r.root.find(
      (n) => typeof n.type === 'string' && n.props.accessibilityLabel === CLOSE_IMAGE_LABEL && StyleSheet.flatten(n.props.style)?.flex === 1,
    );
  }

  test('a tap on the picture opens it full screen on an OPAQUE backdrop; a tap closes it', () => {
    const r = renderCard({ face: pictured, revealed: true });
    expect(r.root.findByType(Modal).props.visible).toBe(false);
    act(() => r.root.find((n) => typeof n.type !== 'string' && n.props.accessibilityRole === 'imagebutton').props.onPress());
    expect(r.root.findByType(Modal).props.visible).toBe(true);
    const bg = StyleSheet.flatten(backdrop(r).props.style).backgroundColor;
    // Opaque: a #RRGGBB colour (no alpha), the colour the card draws behind its images.
    expect(bg).toBe(light.paperSunk);
    expect(String(bg)).toMatch(/^#[0-9a-fA-F]{6}$/);
    // The ✕ button has the same name, and reads on the paper backdrop (ink, not white).
    const close = r.root.findAll((n) => typeof n.type !== 'string' && n.props.label === CLOSE_IMAGE_LABEL && n.props.icon === 'close');
    expect(close).toHaveLength(1);
    expect(close[0].props.color).toBe(light.ink);
    // A tap on the backdrop (the Pressable with the full-screen style, not the ✕ button) closes it.
    const backdropPress = r.root.find(
      (n) =>
        typeof n.type !== 'string' &&
        n.props.accessibilityLabel === CLOSE_IMAGE_LABEL &&
        typeof n.props.onPress === 'function' &&
        typeof n.props.style !== 'function' &&
        StyleSheet.flatten(n.props.style)?.flex === 1,
    );
    act(() => backdropPress.props.onPress());
    expect(r.root.findByType(Modal).props.visible).toBe(false);
  });

  test('Android\'s Back closes it (the shared viewer\'s Modal onRequestClose, wave 5i)', () => {
    const r = renderCard({ face: pictured, revealed: true });
    const picture = r.root.find((n) => typeof n.type !== 'string' && n.props.accessibilityRole === 'imagebutton');
    expect(picture.props.accessibilityHint).toBe(OPEN_IMAGE_HINT);
    act(() => picture.props.onPress());
    expect(r.root.findByType(Modal).props.visible).toBe(true);
    act(() => r.root.findByType(Modal).props.onRequestClose());
    expect(r.root.findByType(Modal).props.visible).toBe(false);
  });
});

describe('StudyCard: the screen-reader focus moves to the answer after the reveal (release pass C1-5)', () => {
  const f = face('führen', [block('to lead', { field: 1, label: 'Back', role: 'meaning' })]);
  const base: CardProps = { face: f, deckId: 'd1', revealed: false, step: null, canSpeak: false, genderColors: false, onSpeak: () => undefined };
  let screenReader = true;
  let focused: { view: unknown; type: string }[] = [];

  beforeEach(() => {
    jest.useFakeTimers();
    screenReader = true;
    focused = [];
    jest.spyOn(AccessibilityInfo, 'isScreenReaderEnabled').mockImplementation(() => Promise.resolve(screenReader));
    jest.spyOn(AccessibilityInfo, 'sendAccessibilityEvent').mockImplementation((view, type) => {
      focused.push({ view, type });
    });
  });

  afterEach(() => {
    if (renderer) act(() => renderer!.unmount());
    renderer = null;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  /** Let the screen-reader answer (a promise) arrive, then wait `ms`. */
  async function wait(ms: number): Promise<void> {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => {
      jest.advanceTimersByTime(ms);
    });
  }

  /** The text of the view the focus moved to (a Text: its children). */
  const textOfView = (view: unknown) => (view as { props: { children?: unknown } }).props.children;

  test('Flashcards, screen reader on: the focus moves to the question line of the answer side, once, after the wait', async () => {
    const onReveal = jest.fn<() => void>();
    const r = renderCard({ ...base, onReveal });
    await wait(REVEAL_FOCUS_DELAY_MS * 2);
    expect(focused).toEqual([]); // nothing on the front
    act(() => r.update(h(StudyCard, { ...base, onReveal, revealed: true })));
    await wait(REVEAL_FOCUS_DELAY_MS - 1);
    expect(focused).toEqual([]); // the answer is still fading in
    await wait(1);
    expect(focused).toHaveLength(1);
    expect(focused[0].type).toBe('focus');
    // The first element of the answer side: the question line, a screen-reader element of its own.
    expect(textOfView(focused[0].view)).toBe('führen');
    const line = r.root.find((n) => typeof n.type === 'string' && n.props.children === 'führen');
    expect(line.props.accessible).toBe(true);
    // Later renders of the same revealed card do not move it again.
    act(() => r.update(h(StudyCard, { ...base, onReveal, revealed: true, hintUsed: true })));
    await wait(REVEAL_FOCUS_DELAY_MS * 2);
    expect(focused).toHaveLength(1);
  });

  test('Typing (the "Check" button was on the front): the focus moves to the answer side too', async () => {
    const r = renderCard(base);
    act(() => r.update(h(StudyCard, { ...base, revealed: true })));
    await wait(REVEAL_FOCUS_DELAY_MS);
    expect(focused).toHaveLength(1);
    expect(textOfView(focused[0].view)).toBe('führen');
  });

  test('no screen reader on: nothing moves (it only asks)', async () => {
    screenReader = false;
    const onReveal = jest.fn<() => void>();
    const r = renderCard({ ...base, onReveal });
    act(() => r.update(h(StudyCard, { ...base, onReveal, revealed: true })));
    await wait(REVEAL_FOCUS_DELAY_MS * 3);
    expect(AccessibilityInfo.isScreenReaderEnabled).toHaveBeenCalled();
    expect(focused).toEqual([]);
  });

  test('a card drawn already revealed does not take the focus (only the reveal itself moves it)', async () => {
    renderCard({ ...base, revealed: true });
    await wait(REVEAL_FOCUS_DELAY_MS * 3);
    expect(focused).toEqual([]);
  });

  test('the card goes away before the wait ends: nothing is sent', async () => {
    const onReveal = jest.fn<() => void>();
    const r = renderCard({ ...base, onReveal });
    act(() => r.update(h(StudyCard, { ...base, onReveal, revealed: true })));
    await wait(REVEAL_FOCUS_DELAY_MS - 50);
    act(() => r.unmount());
    renderer = null;
    await wait(REVEAL_FOCUS_DELAY_MS * 2);
    expect(focused).toEqual([]);
  });

  test('Articles draws its own result (answerOverride, a live region): no target, nothing is sent, no crash', async () => {
    const props = { ...base, promptOverride: h('Text', null, 'Hund'), promptLabel: 'Hund' };
    const r = renderCard(props);
    act(() => r.update(h(StudyCard, { ...props, revealed: true, answerOverride: h('Text', null, 'Richtig') })));
    await wait(REVEAL_FOCUS_DELAY_MS * 2);
    expect(focused).toEqual([]);
  });

  test('focusAfterReveal: a failing screen-reader read or a missing target does nothing and never throws', async () => {
    const view = { props: { children: 'x' } } as unknown as Parameters<typeof AccessibilityInfo.sendAccessibilityEvent>[0];
    // The read rejects.
    jest.mocked(AccessibilityInfo.isScreenReaderEnabled).mockImplementation(() => Promise.reject(new Error('no')));
    focusAfterReveal(() => view);
    await wait(REVEAL_FOCUS_DELAY_MS * 2);
    expect(focused).toEqual([]);
    // The read throws at once (an old web build without the method).
    jest.mocked(AccessibilityInfo.isScreenReaderEnabled).mockImplementation(() => {
      throw new Error('missing');
    });
    expect(() => focusAfterReveal(() => view)).not.toThrow();
    // On, but the target is gone by then.
    jest.mocked(AccessibilityInfo.isScreenReaderEnabled).mockImplementation(() => Promise.resolve(true));
    focusAfterReveal(() => null);
    await wait(REVEAL_FOCUS_DELAY_MS * 2);
    expect(focused).toEqual([]);
    // On, with a target: one focus event; a cancel before the wait sends nothing.
    focusAfterReveal(() => view, 10);
    const cancel = focusAfterReveal(() => view, 10);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    cancel();
    act(() => {
      jest.advanceTimersByTime(10);
    });
    expect(focused).toEqual([{ view, type: 'focus' }]);
  });

  /* ---- wave 5g, review of C1-5: a question with no text has no question line on the answer side */

  /** A face whose question headline is only a picture (htmlLines gives '' as its text). */
  const pictureQuestion = (answer: FieldBlock[]): CardFace => ({
    promptPlain: '',
    answerPlain: answer[0]?.plain ?? '',
    badges: [],
    prompt: [block('', { lines: [[{ t: 'img', src: 'question.png' }]] })],
    answer,
  });

  /** All the text inside a test node (its string children, deep). */
  const textContent = (n: ReactTestInstance | string): string => (typeof n === 'string' ? n : n.children.map(textContent).join(''));

  /** All the text inside a React element's children (what a focused view holds). */
  const elementText = (x: unknown): string => {
    if (typeof x === 'string' || typeof x === 'number') return String(x);
    if (Array.isArray(x)) return x.map(elementText).join('');
    if (x && typeof x === 'object' && 'props' in x) return elementText((x as { props: { children?: unknown } }).props.children);
    return '';
  };

  /**
   * The HOST Texts that are screen-reader elements (`accessible`) with no visible text: silent
   * TalkBack stops. As their text in quotes (a small value, so a failure message stays short).
   */
  const silentStops = (r: ReactTestRenderer): string[] =>
    r.root
      .findAll((n) => n.type === ('Text' as unknown) && n.props.accessible === true && textContent(n).trim() === '')
      .map((n) => JSON.stringify(textContent(n)));

  test('a picture-only question: no empty question line; the focus goes to the answer headline\'s first line of text', async () => {
    const f = pictureQuestion([block('to lead', { field: 1, label: 'Back', role: 'meaning' })]);
    const onReveal = jest.fn<() => void>();
    const r = renderCard({ ...base, face: f, onReveal });
    act(() => r.update(h(StudyCard, { ...base, face: f, onReveal, revealed: true })));
    // No empty screen-reader element anywhere on the answer side.
    expect(silentStops(r)).toEqual([]);
    await wait(REVEAL_FOCUS_DELAY_MS);
    expect(focused).toHaveLength(1);
    // The target: the answer headline's first line, a screen-reader element of its own.
    const view = focused[0].view as { props: { accessible?: boolean; children?: unknown } };
    expect(elementText(view.props.children)).toBe('to lead');
    expect(view.props.accessible).toBe(true);
  });

  test('an EMPTY question block (no text, no picture): no empty line either, the focus goes to the answer', async () => {
    const f: CardFace = { promptPlain: '', answerPlain: 'to lead', badges: [], prompt: [block('')], answer: [block('to lead', { field: 1, role: 'meaning' })] };
    const r = renderCard({ ...base, face: f });
    act(() => r.update(h(StudyCard, { ...base, face: f, revealed: true })));
    expect(silentStops(r)).toEqual([]);
    await wait(REVEAL_FOCUS_DELAY_MS);
    expect(focused).toHaveLength(1);
    expect(elementText((focused[0].view as { props: { children?: unknown } }).props.children)).toBe('to lead');
  });

  test('a picture-only question and a picture-first answer: the focus goes to the answer picture (and to its placeholder when it fails)', async () => {
    const f = pictureQuestion([block('', { field: 1, role: 'meaning', lines: [[{ t: 'img', src: 'answer.png' }], [{ t: 'text', text: 'a tree' }]] })]);
    const onReveal = jest.fn<() => void>();
    const r = renderCard({ ...base, face: f, onReveal });
    act(() => r.update(h(StudyCard, { ...base, face: f, onReveal, revealed: true })));
    expect(silentStops(r)).toEqual([]);
    await wait(REVEAL_FOCUS_DELAY_MS);
    expect(focused).toHaveLength(1);
    const picture = focused[0].view as { props: { accessibilityRole?: string; accessibilityLabel?: string } };
    expect(picture.props.accessibilityRole).toBe('imagebutton');
    expect(picture.props.accessibilityLabel).toBe('Picture');
    // The same card again, with a picture that cannot be drawn: its placeholder takes the focus.
    act(() => r.unmount());
    renderer = null;
    focused = [];
    const r2 = renderCard({ ...base, face: f, onReveal });
    act(() => r2.update(h(StudyCard, { ...base, face: f, onReveal, revealed: true })));
    act(() => r2.root.find((n) => n.type === ('ExpoImage' as unknown)).props.onError());
    await wait(REVEAL_FOCUS_DELAY_MS);
    expect(focused).toHaveLength(1);
    expect((focused[0].view as { props: { accessibilityLabel?: string } }).props.accessibilityLabel).toBe('Picture answer.png is not available');
  });

  test('a picture-only question and a German term answer (gender colours): the focus goes to the term, one element', async () => {
    const f = pictureQuestion([block('der Hund', { field: 1, role: 'term', lang: 'de-DE' })]);
    const r = renderCard({ ...base, face: f, genderColors: true });
    act(() => r.update(h(StudyCard, { ...base, face: f, genderColors: true, revealed: true })));
    expect(silentStops(r)).toEqual([]);
    await wait(REVEAL_FOCUS_DELAY_MS);
    expect(focused).toHaveLength(1);
    const term = focused[0].view as { props: { accessible?: boolean; accessibilityLabel?: string } };
    expect(term.props.accessible).toBe(true);
    expect(term.props.accessibilityLabel).toBe('der Hund');
  });

  test('a picture-only question, no screen reader on: nothing moves', async () => {
    screenReader = false;
    const f = pictureQuestion([block('to lead', { field: 1, role: 'meaning' })]);
    const r = renderCard({ ...base, face: f });
    act(() => r.update(h(StudyCard, { ...base, face: f, revealed: true })));
    await wait(REVEAL_FOCUS_DELAY_MS * 3);
    expect(focused).toEqual([]);
  });

  test('with a question line the old behaviour stays: the line is the target, and the answer headline gets no extra element', async () => {
    const f = face('führen', [block('to lead', { field: 1, label: 'Back', role: 'meaning' }), block('', { field: 2, role: 'detail' })]);
    const r = renderCard({ ...base, face: f });
    act(() => r.update(h(StudyCard, { ...base, face: f, revealed: true })));
    await wait(REVEAL_FOCUS_DELAY_MS);
    expect(focused).toHaveLength(1);
    expect(textOfView(focused[0].view)).toBe('führen');
    // The answer headline's Text is drawn as before: not made a screen-reader element of its own.
    const headline = r.root.findAll((n) => n.type === ('Text' as unknown) && textContent(n) === 'to lead' && n.parent?.type !== ('Text' as unknown));
    expect(headline.length).toBeGreaterThan(0);
    for (const n of headline) expect(n.props.accessible).toBeUndefined();
    expect(silentStops(r)).toEqual([]);
  });

  /* ---- wave 5h, C2 review of wave 5g: Typing / Quiz with a picture-only question ---- */

  /**
   * The mode's result on the answer side, like the session draws it: a "You typed: …" line
   * (TypingAnswer) holding the focus ref, then a verdict line. Drawn BEFORE the answer headline.
   */
  function typingResult(ref: React.RefObject<Text | null>) {
    return h(React.Fragment, null, h(Text, { ref, accessibilityLabel: 'You typed: tree. “e” is missing.' }, 'tre'), h(Text, null, 'Almost — a small typo'));
  }

  test('a picture-only question in Typing: the focus goes to the typing result (drawn before the answer), not the answer headline', async () => {
    const f = pictureQuestion([block('a tree', { field: 1, role: 'meaning' })]);
    const ref = React.createRef<Text>();
    const r = renderCard({ ...base, face: f });
    act(() => r.update(h(StudyCard, { ...base, face: f, revealed: true, answerExtra: typingResult(ref), answerExtraFocus: ref })));
    await wait(REVEAL_FOCUS_DELAY_MS);
    expect(focused).toHaveLength(1);
    expect(focused[0].view).toBe(ref.current);
    expect((focused[0].view as { props: { accessibilityLabel?: string } }).props.accessibilityLabel).toBe('You typed: tree. “e” is missing.');
    expect(silentStops(r)).toEqual([]);
  });

  test('a picture-only question in Quiz: the focus goes to the PICKED choice', async () => {
    const f = pictureQuestion([block('a tree', { field: 1, role: 'meaning' })]);
    const ref = React.createRef<View>();
    const choices = h(
      View,
      null,
      h(View, { accessible: true, accessibilityLabel: 'Answer 1 of 4: a tree. Right answer.' }),
      h(View, { ref, accessible: true, accessibilityLabel: 'Answer 2 of 4: a bush. Your choice, wrong.' }),
    );
    const r = renderCard({ ...base, face: f });
    act(() => r.update(h(StudyCard, { ...base, face: f, revealed: true, answerExtra: choices, answerExtraFocus: ref })));
    await wait(REVEAL_FOCUS_DELAY_MS);
    expect(focused).toHaveLength(1);
    expect((focused[0].view as { props: { accessibilityLabel?: string } }).props.accessibilityLabel).toBe('Answer 2 of 4: a bush. Your choice, wrong.');
  });

  test('with a question line the question line stays the target, also with a typing result (nothing is skipped there)', async () => {
    const f = face('Baum', [block('a tree', { field: 1, role: 'meaning' })]);
    const ref = React.createRef<Text>();
    const r = renderCard({ ...base, face: f });
    act(() => r.update(h(StudyCard, { ...base, face: f, revealed: true, answerExtra: typingResult(ref), answerExtraFocus: ref })));
    await wait(REVEAL_FOCUS_DELAY_MS);
    expect(focused).toHaveLength(1);
    expect(textOfView(focused[0].view)).toBe('Baum');
  });

  test('a picture-only question whose mode draws no result (Flashcards: the ref stays empty): the answer headline, as before', async () => {
    const f = pictureQuestion([block('a tree', { field: 1, role: 'meaning' })]);
    const ref = React.createRef<Text>();
    const onReveal = jest.fn<() => void>();
    const r = renderCard({ ...base, face: f, onReveal, answerExtraFocus: ref });
    act(() => r.update(h(StudyCard, { ...base, face: f, onReveal, revealed: true, answerExtraFocus: ref })));
    await wait(REVEAL_FOCUS_DELAY_MS);
    expect(focused).toHaveLength(1);
    expect(elementText((focused[0].view as { props: { children?: unknown } }).props.children)).toBe('a tree');
  });

  test('a picture-only question in Typing, no screen reader on: nothing moves', async () => {
    screenReader = false;
    const f = pictureQuestion([block('a tree', { field: 1, role: 'meaning' })]);
    const ref = React.createRef<Text>();
    const r = renderCard({ ...base, face: f });
    act(() => r.update(h(StudyCard, { ...base, face: f, revealed: true, answerExtra: typingResult(ref), answerExtraFocus: ref })));
    await wait(REVEAL_FOCUS_DELAY_MS * 3);
    expect(focused).toEqual([]);
  });
});

describe('StudyCard: every picture sits on the light image well (wave 5g, Evening)', () => {
  /** A revealed card whose answer has a picture line. */
  const pictured = face('What does a hash table store?', [
    block('Select items', { field: 1, role: 'meaning', lines: [[{ t: 'text', text: 'Select items' }], [{ t: 'img', src: 'sample.png' }]] }),
  ]);

  /** The nearest HOST View above a node (the box an image is drawn in). */
  function hostViewAbove(n: ReactTestInstance): ReactTestInstance {
    let at = n.parent;
    while (at && at.type !== ('View' as unknown)) at = at.parent;
    if (!at) throw new Error('no host View above');
    return at;
  }

  const styleOf = (n: ReactTestInstance) => StyleSheet.flatten(n.props.style) ?? {};

  test('Evening: the picture on the card is drawn on c.imageWell (light), not on the dark paperSunk', () => {
    mockTheme = 'dark';
    const r = renderCard({ face: pictured, revealed: true });
    const images = r.root.findAll((n) => n.type === ('ExpoImage' as unknown));
    expect(images.length).toBe(1);
    expect(styleOf(images[0]).backgroundColor).toBe(dark.imageWell);
    expect(dark.imageWell).not.toBe(dark.paperSunk);
  });

  test('Paper: nothing changes (the well is still paperSunk)', () => {
    const r = renderCard({ face: pictured, revealed: true });
    expect(styleOf(r.root.find((n) => n.type === ('ExpoImage' as unknown))).backgroundColor).toBe(light.paperSunk);
  });

  test('Evening: the placeholder of a picture that cannot be drawn keeps its quiet paperSunk look', () => {
    mockTheme = 'dark';
    const r = renderCard({ face: pictured, revealed: true });
    act(() => r.root.find((n) => n.type === ('ExpoImage' as unknown)).props.onError());
    const placeholder = r.root.find((n) => n.type === ('View' as unknown) && n.props.accessibilityLabel === 'Picture sample.png is not available');
    expect(styleOf(placeholder).backgroundColor).toBe(dark.paperSunk);
  });

  test('Evening, full screen: the backdrop stays the opaque paperSunk; the picture gets a well of its own shape once it is loaded', () => {
    mockTheme = 'dark';
    const r = renderCard({ face: pictured, revealed: true });
    act(() => r.root.find((n) => typeof n.type !== 'string' && n.props.accessibilityRole === 'imagebutton').props.onPress());
    const modal = r.root.findByType(Modal);
    expect(modal.props.visible).toBe(true);
    // The backdrop: opaque, the dark paperSunk (K1-4), NOT the light well.
    const backdrop = modal.find(
      (n) => n.type === ('View' as unknown) && n.props.accessibilityLabel === CLOSE_IMAGE_LABEL && styleOf(n).flex === 1,
    );
    expect(styleOf(backdrop).backgroundColor).toBe(dark.paperSunk);
    const image = modal.find((n) => n.type === ('ExpoImage' as unknown));
    // Before the picture has loaded (its shape is unknown): no well yet.
    expect(modal.findAll((n) => n.type === ('View' as unknown) && styleOf(n).backgroundColor === dark.imageWell).length).toBe(0);
    // The space it may use (layout), then its shape (a 2:1 picture).
    const area = modal.find((n) => n.type === ('View' as unknown) && typeof n.props.onLayout === 'function');
    act(() => area.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 336, height: 700 } } }));
    act(() => image.props.onLoad({ source: { width: 800, height: 400 } }));
    const well = hostViewAbove(modal.find((n) => n.type === ('ExpoImage' as unknown)));
    expect(styleOf(well)).toMatchObject({ width: 336, height: 168, backgroundColor: dark.imageWell });
    // The picture fills its well.
    expect(styleOf(modal.find((n) => n.type === ('ExpoImage' as unknown)))).toMatchObject({ width: '100%', height: '100%' });
  });

  test('containSize: the picture\'s own shape, as big as fits the box', () => {
    expect(containSize({ width: 300, height: 600 }, 2)).toEqual({ width: 300, height: 150 }); // wide: full width
    expect(containSize({ width: 300, height: 600 }, 0.25)).toEqual({ width: 150, height: 600 }); // tall: full height
    expect(containSize({ width: 300, height: 600 }, 0.5)).toEqual({ width: 300, height: 600 }); // the same shape
    // Not known yet, or not a real size: no well.
    expect(containSize(null, 2)).toBeNull();
    expect(containSize({ width: 300, height: 600 }, null)).toBeNull();
    expect(containSize({ width: 300, height: 600 }, 0)).toBeNull();
    expect(containSize({ width: 300, height: 600 }, Number.NaN)).toBeNull();
    expect(containSize({ width: 0, height: 600 }, 2)).toBeNull();
    expect(containSize({ width: 300, height: -1 }, 2)).toBeNull();
  });
});
