/**
 * Tests for the CardSheet (spec §8.4, §6.5 "Card info", §7 #19-21 and #49,
 * unit A1).
 *
 * Part 1 — the pure rules (src/components/sheets/cardSheetLogic.ts):
 *   - the data the sheet reads (card, note, card type, deck, siblings) and
 *     its selector, which keeps the same object while nothing changed;
 *   - the face layout (headline, subline, labelled rows, badges, cloze);
 *   - wave 5h: a session's "Card info" before the reveal shows the question
 *     only (sheetFace / questionLayout; the component too), never the answer;
 *   - the status line ("Review · next in 4 days · suspended"), DST-safe days;
 *   - the toggles: labels are the ACTION (Unflag on a flagged card), so the
 *     flag state is always visible; their patches and snackbars;
 *   - the Status control: "Not started" only for a never-studied card;
 *   - which rows show (read-only hides every edit row; Reset only with
 *     progress; Reschedule only with a schedule; Practice only when the
 *     session would really show the card);
 *   - the History line, with lapses counted from the history rows only —
 *     pinned against the REAL scheduler (srs.ts) on random rating runs;
 *     the read-only "Lapses" row says why when its number differs;
 *   - the tag chip's Library route and the other routes and copy.
 *
 * Part 2 — the component's wiring (CardSheet.tsx), rendered with
 * react-test-renderer. Module mocks (`jest.mock` below): the store hooks
 * read one in-memory state, and every action runs the REAL reducer on it;
 * the theme is the light palette; icons, images, the date picker, the
 * router, read-aloud and the review history are small fakes; the snackbar
 * is a small channel that works like SnackbarProvider, so the test can see
 * the Undo bar the sheet draws on its panel.
 *
 * Part 3 — wave 5b polish from the device walkthrough, on the parts the
 * CardSheet is built from (Sheet, SnackbarView, FieldRows) and the channel
 * behind its Undo bar (the REAL SnackbarProvider, jest.requireActual):
 *   - M5: an Undo stays at least 5 s (at least 10 s with a screen reader),
 *     and the sheet's own bar sits at the TOP of the panel, never over
 *     "Delete card…" at the bottom;
 *   - M3: a sheet's body passes the first tap to its buttons while the
 *     keyboard is open (keyboardShouldPersistTaps "handled");
 *   - L3 / R6: field labels are whole (they wrap, never "PRONUNCIATI…") and
 *     never an internal name ("MarankiExample" → "Example");
 *   - L10: the card type list keeps its "…" with the word before it.
 * And the first review of that work:
 *   - the label column grows with the system text size, so a one-word label
 *     never breaks inside the word ("PRONUNCIA / TION");
 *   - useSnackDuration: the same Undo time for a screen with its own
 *     snackbar (the study session);
 *   - the deck editor (rendered, its route params and store mocked) shows
 *     the card type new cards really start with (roles.newCardTypeId), and
 *     offers only choices that take effect (wave 5c: Basic too, saved with
 *     `defaultTypeChosen`).
 * And wave 5c:
 *   - the read-only "Card info" rows use the field rows' label column (it
 *     grows with the text size, the label wraps: never "REPETITI…");
 *   - the card editor (rendered) draws "Added · Undo" at the TOP of the
 *     form, never over "Save & add another", and scrolls back to the top.
 * And wave 5g:
 *   - a card picture sits on the light image well (`imageWell`) in Evening,
 *     and on the same paperSunk well as before in Paper. Wave 5i: a tap on
 *     it opens the study card's full-screen viewer (src/components/ui/
 *     ImageViewer.tsx), and Back closes the picture before the sheet. For it the media
 *     mock can give a file address (`mockMediaUri`) and the theme mock the
 *     dark palette (`mockTheme`); both go back to their defaults after it.
 */
// '@jest/globals' first: the jest.mock factories below use its `jest`.
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import React from 'react';
import TestRenderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { builtinType, BUILTIN_TYPE_IDS } from '../../domain/builtinTypes';
import { blockText, speechOf, type SpokenText } from '../../domain/face';
import type { Card, CardFace, DataStateV3, FieldBlock, NoteType, Rating, RevlogRow } from '../../domain/model';
import { parseQueryParam } from '../../domain/query';
import { noteIdsInDeck } from '../../domain/fieldText';
import { renderFace } from '../../domain/render';
import { newCardTypeId, parseTemplate, toTemplateDef } from '../../domain/roles';
import { buildSessionQueue, matchCtxOf } from '../../domain/scope';
import { applyRating } from '../../domain/srs';
import { DAY, DEFAULT_SRS, HOUR, MIN } from '../../domain/types';
import { migrate } from '../../store/migrate';
import * as reducer from '../../store/reducer';
import { getSelection } from '../../store/selectionRegistry';
import type { SnackMessage } from '../../store/SnackbarContext';
import { addLocalDays as sameClockDaysLater, FIXED_NOW, localTime } from '../../test/clock';
import { stateFixture } from '../../test/factories';
import { cardInLifeV3, lifeValues, makeDeckV3, noteWithCards, stateOfV3, testCtx } from '../../test/factoriesV3';
import { createRandom } from '../../test/random';
import { DateTimePicker } from '@expo/ui/community/datetime-picker';
import { AccessibilityInfo, Dimensions, Modal, Platform, ScrollView, StyleSheet, Text } from 'react-native';
import { dark, light } from '../../theme/tokens';
import { nextReviewLong, nextReviewShort, reviewWait } from '../../utils/dateFormatting';

import CardEditorScreen from '../../app/card-editor';
import DeckEditorScreen from '../../app/deck-editor';
import { CardTypePicker, keepEllipsisWithWord } from '../editor/CardTypePicker';
import { btnSlop } from '../ui/buttons';
import { FieldRows, LABEL_COLUMN_WIDTH, LABEL_FONT_CAP, labelColumnWidth } from '../ui/FieldRows';
import { CLOSE_IMAGE_LABEL, OPEN_IMAGE_HINT } from '../ui/ImageViewer';
import { Sheet } from '../ui/Sheet';
import { SnackbarHost, SnackbarView } from '../ui/SnackbarHost';
import { rowStatus } from '../library/libraryState';
import { RescheduleSheet } from '../study/RescheduleSheet';
import { addLocalDays, choiceDueMs, NOTHING_TO_RESCHEDULE, rescheduleSnack } from '../study/rescheduleLogic';
import { CardSheet } from './CardSheet';
import {
  blockImages,
  CARD_SHEET_COPY,
  cardLabel,
  cardSheetSections,
  cardSheetSourceOf,
  cardSheetSourceReader,
  cardStatus,
  deckPath,
  deleteConfirmBody,
  deleteRowSub,
  deleteSnack,
  editCardRoute,
  faceLayout,
  flagPatch,
  flagSnack,
  flagToggles,
  headlineText,
  historyLapsesOf,
  historyLineOf,
  infoRows,
  isStatusSegment,
  LAPSES_FEWER_NOTE,
  LAPSES_MORE_NOTE,
  lapsesNote,
  libraryTagHref,
  moveSnack,
  nextReviewText,
  practiceRoute,
  questionLayout,
  revlogLapseCount,
  SHEET_SNACK_TOP,
  sheetFace,
  statusChange,
  statusSegmentOf,
  statusSegments,
  tagChipLabel,
  visibleTags,
} from './cardSheetLogic';

/* ================================================================ mocks */

/** The one state the mocked store hooks read; the mocked actions run the real reducer on it. */
let mockState: DataStateV3;
let mockPracticeCount = 0;
let mockHistoryRows: RevlogRow[] = [];
/** false = the history read never finishes (so no state update lands after a test's act()). */
let mockHistoryReady = false;
/**
 * The snackbar channel of the tests, like SnackbarProvider: show() puts a NEW
 * message object here, dismiss() clears it, and the components that read it
 * (useSnackbar) render again.
 */
const mockSnackChannel = {
  snack: null as SnackMessage | null,
  listeners: new Set<() => void>(),
  set(next: SnackMessage | null) {
    mockSnackChannel.snack = next;
    for (const listener of mockSnackChannel.listeners) listener();
  },
  subscribe(listener: () => void) {
    mockSnackChannel.listeners.add(listener);
    return () => {
      mockSnackChannel.listeners.delete(listener);
    };
  },
  get: () => mockSnackChannel.snack,
};
const mockShow = jest.fn((text: string, action?: { label?: string; onAction: () => void }) =>
  mockSnackChannel.set({ text, actionLabel: action ? (action.label ?? 'Undo') : undefined, onAction: action?.onAction }),
);
const mockDismiss = jest.fn(() => mockSnackChannel.set(null));
const mockPush = jest.fn<(href: unknown) => void>();
const mockSpeak = jest.fn<(text: string, lang?: string) => void>();

/** Run one reducer command on mockState; returns its result. */
function mockRun<I, R>(command: (s: DataStateV3, input: I, ctx: reducer.ReducerCtx) => { state: DataStateV3; result: R }, input: I): R {
  const step = command(mockState, input, testCtx(FIXED_NOW));
  mockState = step.state;
  return step.result;
}

const mockDeleted = new Map<string, ReturnType<typeof reducer.deleteNotes>['result']>();

const mockActions = {
  setFlags: jest.fn((cardIds: string[], patch: { fav?: boolean; flagged?: boolean; suspended?: boolean }) => mockRun(reducer.setFlags, { cardIds, patch }).edit.id),
  learn: jest.fn((cardIds: string[]) => mockRun(reducer.learn, { cardIds }).edit.id),
  markKnown: jest.fn((cardIds: string[]) => mockRun(reducer.markKnown, { cardIds }).edit.id),
  setNotStarted: jest.fn((cardIds: string[]) => mockRun(reducer.setNotStarted, { cardIds }).edit.id),
  resetProgress: jest.fn((cardIds: string[]) => mockRun(reducer.resetProgress, { cardIds }).edit.id),
  reschedule: jest.fn((cardIds: string[], dueMs: number) => mockRun(reducer.reschedule, { cardIds, dueMs }).edit.id),
  undoManualEdit: jest.fn((editId: string) => mockRun(reducer.undoManualEdit, { editId })),
  moveNotes: jest.fn((noteIds: string[], deckId: string) => mockRun(reducer.moveNotes, { noteIds, deckId }).edit.id),
  deleteNotes: jest.fn((noteIds: string[]) => {
    const removed = mockRun((s, input: { noteIds: string[] }) => reducer.deleteNotes(s, input), { noteIds });
    const token = `del-${mockDeleted.size + 1}`;
    mockDeleted.set(token, removed);
    return token;
  }),
  undoDelete: jest.fn((token: string) => {
    const deleted = mockDeleted.get(token);
    if (!deleted) return false;
    return mockRun((s, input: { deleted: typeof deleted }) => reducer.undoDelete(s, input), { deleted });
  }),
  // The deck editor's save (part 3: its "Card type").
  updateDeck: jest.fn((deckId: string, patch: reducer.DeckPatch) => mockRun(reducer.updateDeck, { deckId, patch })),
  // The card editor's "Save & add another" (part 3: where its "Added · Undo" bar sits).
  addNote: jest.fn((input: { deckId: string; typeId: string; fields: string[]; tags: string[] }) => mockRun(reducer.addNote, input)),
};

/** The deck editor's route params (part 3) and its navigation (the unsaved-changes guard listens to it). */
let mockRouteParams: { deckId?: string } = {};
const mockBack = jest.fn();
const mockNavigation = { addListener: jest.fn(() => () => undefined) };

// The deck editor (part 3) reads the state through useData(); the CardSheet only its actions.
jest.mock('../../store/DataContext', () => ({ useData: () => ({ state: mockState, actions: mockActions }) }));

jest.mock('../../store/selectors', () => ({
  ...jest.requireActual<typeof import('../../store/selectors')>('../../store/selectors'),
  useStateV3: <T,>(selector: (state: DataStateV3) => T): T => selector(mockState),
  useEngine: () => ({ store: { getState: () => mockState } }),
  useSessionLength: () => mockPracticeCount,
}));

jest.mock('../../store/SnackbarContext', () => ({
  useSnackbar: () => {
    const snack = jest
      .requireActual<typeof import('react')>('react')
      .useSyncExternalStore(mockSnackChannel.subscribe, mockSnackChannel.get);
    return { show: mockShow, snack, dismiss: mockDismiss };
  },
}));

// Only the review history (the real module opens the phone's databases).
jest.mock('../../store/storage', () => ({
  appRevlogStore: () => ({
    forCard: (id: string) =>
      mockHistoryReady ? Promise.resolve(mockHistoryRows.filter((r) => r.cardId === id)) : new Promise<RevlogRow[]>(() => undefined),
  }),
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: mockBack }),
  useLocalSearchParams: () => mockRouteParams,
  useNavigation: () => mockNavigation,
}));
// The deck editor asks which languages the phone can read aloud.
jest.mock('expo-speech', () => ({ getAvailableVoicesAsync: () => Promise.resolve([]) }));
jest.mock('expo-image', () => ({ Image: () => null }));
jest.mock('@expo/ui/community/datetime-picker', () => ({
  DateTimePicker: function DateTimePicker() {
    return null;
  },
}));
jest.mock('../../domain/speech', () => ({ speak: (text: string, lang?: string) => mockSpeak(text, lang) }));
/** The file address of a deck image. By default none (a missing file); the image-well test gives one. */
let mockMediaUri: (deckId: string, name: string) => string | null = () => null;
jest.mock('../../platform/media', () => ({ mediaFileUri: (deckId: string, name: string) => mockMediaUri(deckId, name) }));

/** The palette useColors() gives: Paper, or Evening when the image-well test sets 'dark'. */
let mockTheme: 'light' | 'dark' = 'light';
jest.mock('../../theme/ThemeContext', () => ({
  useColors: () => jest.requireActual<typeof import('../../theme/tokens')>('../../theme/tokens')[mockTheme],
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

/* ================================================================ fixtures */

const NOW = FIXED_NOW;

/** A deck with one Basic + reverse note ("die Reise" / "the trip"), card c1 = ord 0, c2 = ord 1. */
function fixture(cardOverrides: Partial<Card> = {}, now: number = NOW): DataStateV3 {
  const deck = makeDeckV3({ id: 'd1', name: 'German', icon: '🇩🇪', language: 'de-DE', meaningLanguage: 'en-US' });
  const other = makeDeckV3({ id: 'd2', name: 'Spanish', icon: '🇪🇸' });
  const group = noteWithCards({
    deckId: 'd1',
    typeId: BUILTIN_TYPE_IDS.basicReverse,
    fields: ['die Reise', 'the trip', 'Die Reise war lang.', ''],
    note: { id: 'n1', tags: ['Travel', 'Algo::Core_Patterns'], section: 'Vocabulary::B1' },
    card: (ord) => ({ id: `c${ord + 1}`, ...(ord === 0 ? { ...lifeValues('review', now), ...cardOverrides } : {}) }),
  });
  return stateOfV3({ decks: [deck, other], groups: [group] });
}

/** The face of a card of `state` (the real renderer). */
function faceOf(state: DataStateV3, cardId: string): CardFace {
  // Destructured: the face guard (face.test.ts) forbids a direct property read of the notes here.
  const { cards, notes, noteTypes, decks } = state;
  const card = cards.find((c) => c.id === cardId)!;
  const note = notes.find((n) => n.id === card.noteId)!;
  const type = noteTypes.find((t) => t.id === note.typeId)!;
  return renderFace(note, type, card.ord, decks.find((d) => d.id === card.deckId));
}

/** A field block for synthetic faces. */
function block(field: number, text: string, extra: Partial<FieldBlock> = {}): FieldBlock {
  return { field, label: `F${field}`, role: 'detail', lines: [[{ t: 'text', text }]], plain: text, ...extra };
}

/** One history row. */
function row(seq: number, extra: Partial<RevlogRow> = {}): RevlogRow {
  return {
    seq,
    cardId: 'c1',
    deckId: 'd1',
    atMs: NOW - (10 - seq) * DAY,
    rating: 'good',
    bucket: 'review',
    ivlBefore: 1,
    ivlAfter: 3,
    easeAfter: 2.5,
    durationMs: null,
    ...extra,
  };
}

/* ================================================================ part 1: the rules */

describe('cardSheetSourceOf / cardSheetSourceReader', () => {
  it('finds the card, its note, card type, deck and how many directions the note has', () => {
    const state = fixture();
    const source = cardSheetSourceOf(state, 'c1')!;
    expect(source.card.id).toBe('c1');
    expect(source.note?.id).toBe('n1');
    expect(source.type?.id).toBe(BUILTIN_TYPE_IDS.basicReverse);
    expect(source.deck?.id).toBe('d1');
    expect(source.siblings).toBe(2);
    expect(cardSheetSourceOf(state, 'gone')).toBeNull();
    expect(cardSheetSourceOf(state, null)).toBeNull();
  });

  it('the selector keeps the SAME object until this card (or its note/type/deck) changes', () => {
    const state = fixture();
    const read = cardSheetSourceReader('c1');
    const first = read(state);
    const otherCardChanged = { ...state, cards: state.cards.map((c) => (c.id === 'c2' ? { ...c, fav: true } : c)) };
    expect(read(otherCardChanged)).toBe(first);
    const thisCardChanged = { ...state, cards: state.cards.map((c) => (c.id === 'c1' ? { ...c, flagged: true } : c)) };
    const next = read(thisCardChanged);
    expect(next).not.toBe(first);
    expect(next?.card.flagged).toBe(true);
    // Deleted → null.
    expect(read({ ...state, cards: state.cards.filter((c) => c.noteId !== 'n1') })).toBeNull();
  });
});

describe('faceLayout', () => {
  it('Basic: the front is the headline, the back the subline, the rest are rows', () => {
    const state = fixture();
    const layout = faceLayout(faceOf(state, 'c1'));
    expect(headlineText(layout.headline)).toBe('die Reise');
    expect(headlineText(layout.subline)).toBe('the trip');
    // The empty Notes field has no block at all (renderFace leaves empty fields out).
    expect(layout.rows.map((b) => b.label)).toEqual(['Example']);
    // The reverse direction swaps headline and subline.
    const reverse = faceLayout(faceOf(state, 'c2'));
    expect(headlineText(reverse.headline)).toBe('the trip');
    expect(headlineText(reverse.subline)).toBe('die Reise');
  });

  it('a card type with badges: prompt fields, answer fields, then the badges (Level, Type)', () => {
    const type = builtinType('legacyVocabDe', NOW);
    const fields = ['die Reise', 'the trip', 'Die Reise war lang.', 'The trip was long.', '/ˈʁaɪ̯zə/', 'B1', 'noun', 'die', 'Reise', 'Note'];
    const note = noteWithCards({ deckId: 'd1', typeId: type.id, fields, note: { id: 'nv' } }, [type]).note;
    const layout = faceLayout(renderFace(note, type, 0));
    expect(headlineText(layout.headline)).toBe('die Reise');
    expect(headlineText(layout.subline)).toBe('the trip');
    expect(layout.rows.map((b) => b.plain)).toEqual(['/ˈʁaɪ̯zə/', 'Die Reise war lang.', 'The trip was long.', 'Note', 'B1', 'noun']);
  });

  it('cloze: the question and the revealed text are headline and subline; Extra is a row', () => {
    const type = builtinType('cloze', NOW);
    const note = noteWithCards(
      { deckId: 'd1', typeId: type.id, fields: ['{{c1::Paris}} is in {{c2::France}}', 'capital'], note: { id: 'nc' } },
      [type],
    ).note;
    const layout = faceLayout(renderFace(note, type, 0));
    expect(headlineText(layout.headline)).toBe('[…] is in France');
    expect(headlineText(layout.subline)).toBe('Paris is in France');
    expect(layout.rows.map((b) => b.plain)).toEqual(['capital']);
  });

  it('a field on both sides is ONE row (the answer version, at its first place); the headline field is not repeated', () => {
    const face: CardFace = {
      promptPlain: 'q',
      answerPlain: 'a',
      badges: [block(9, 'B1', { role: 'badge' })],
      prompt: [block(0, 'q'), block(1, 'hidden [...]'), block(2, 'pron')],
      answer: [block(3, 'a'), block(1, 'revealed'), block(0, 'q again'), block(4, 'extra')],
    };
    const layout = faceLayout(face);
    expect(layout.rows.map((b) => [b.field, b.plain])).toEqual([
      [1, 'revealed'],
      [2, 'pron'],
      [4, 'extra'],
      [9, 'B1'],
    ]);
  });

  it('a dictation question (🔊 only) shows the word in the sheet; images are listed per block', () => {
    const speaker: FieldBlock = { field: 0, label: 'Word', role: 'term', lines: [[{ t: 'text', text: '🔊' }]], plain: 'Haus' };
    expect(headlineText(speaker)).toBe('Haus');
    expect(blockText(speaker)).toBe('🔊');
    const withImages: FieldBlock = {
      ...block(1, 'Map'),
      lines: [[{ t: 'text', text: 'Map' }, { t: 'img', src: 'map.png' }], [{ t: 'img', src: 'b.jpg' }, { t: 'sound', src: 'x.mp3' }]],
    };
    expect(blockImages(withImages)).toEqual(['map.png', 'b.jpg']);
    expect(blockImages(null)).toEqual([]);
    expect(headlineText(null)).toBe('');
  });

  it("a dictation card (Anki's '{{tts de_DE:Word}}{{type:Word}}') shows the word ONCE, with its meaning as the subline", () => {
    // The real import path: the Anki templates → parseTemplate → toTemplateDef → renderFace.
    const qfmt = '{{tts de_DE:Word}}{{type:Word}}';
    const afmt = '{{Word}}<br>{{Meaning}}';
    const fields: NoteType['fields'] = [
      { name: 'Word', role: 'term', facet: 'off' },
      { name: 'Meaning', role: 'meaning', facet: 'off' },
    ];
    const parsed = parseTemplate(qfmt, afmt, ['Word', 'Meaning']);
    const type: NoteType = {
      ...builtinType('basic', NOW),
      id: 'nt-dictation',
      name: 'Dictation',
      fields,
      templates: [toTemplateDef(parsed, fields, { ord: 0, name: 'Dictation', qfmt, afmt })],
      source: { ankiMid: '42' },
    };
    const note = noteWithCards({ deckId: 'd1', typeId: type.id, fields: ['das Haus', 'the house'], note: { id: 'nd' } }, [type]).note;
    const face = renderFace(note, type, 0);
    // The face: the 🔊 question of Word, and the answer starts with Word again.
    expect(face.prompt.map((b) => b.field)).toEqual([0]);
    expect(face.answer.map((b) => b.field)).toEqual([0, 1]);

    const layout = faceLayout(face);
    expect(headlineText(layout.headline)).toBe('das Haus');
    expect(headlineText(layout.subline)).toBe('the house'); // not "das Haus" a second time
    expect(layout.rows).toEqual([]); // the meaning is the subline, not a labelled row
  });

  it('a card MIGRATED from v2.0.2 (word/tr) shows its pronunciation, Level and Type (device finding)', () => {
    const out = migrate(stateFixture('v0-v2.0.2'), NOW);
    if (out.kind !== 'ok') throw new Error(`the fixture did not migrate: ${out.kind}`);
    const source = cardSheetSourceOf(out.state, 'c-mr8whcrk-cat1');
    if (!source?.note || !source.type) throw new Error('the migrated card has no note or card type');
    const layout = faceLayout(renderFace(source.note, source.type, source.card.ord));
    expect(headlineText(layout.headline)).toBe('die Stunde');
    expect(headlineText(layout.subline)).toBe('the hour');
    const rows = layout.rows.map((b) => b.plain);
    expect(rows).toEqual(expect.arrayContaining(['/ˈʃtʊndə/', 'Wir treffen uns in einer Stunde.', 'A1', 'noun']));
    // The badges are labelled rows (FieldRows draws them), after the other fields.
    expect(layout.rows.slice(-2).map((b) => b.role)).toEqual(['badge', 'badge']);
  });

  it('a hand-made dictation face: the answer block that repeats the headline is skipped, the next one is the subline', () => {
    const speaker: FieldBlock = { field: 0, label: 'Word', role: 'term', lines: [[{ t: 'text', text: '🔊' }]], plain: 'das Haus' };
    const face: CardFace = {
      promptPlain: '🔊',
      answerPlain: 'das Haus',
      badges: [block(3, 'A1', { role: 'badge' })],
      prompt: [speaker],
      answer: [block(0, 'das Haus'), block(1, 'the house'), block(2, 'Das Haus ist alt.')],
    };
    const layout = faceLayout(face);
    expect(layout.headline).toBe(speaker);
    expect(layout.subline?.plain).toBe('the house');
    expect(layout.rows.map((b) => [b.field, b.plain])).toEqual([
      [2, 'Das Haus ist alt.'],
      [3, 'A1'],
    ]);
    // Only a REPEAT is skipped: the same field with other text (a cloze) stays the subline.
    const clozeLike: CardFace = { ...face, prompt: [block(0, '[…] Haus')], answer: [block(0, 'das Haus'), block(1, 'the house')] };
    expect(faceLayout(clozeLike).subline?.plain).toBe('das Haus');
  });

  it('cardLabel: one short line, or "Card"', () => {
    expect(cardLabel(faceOf(fixture(), 'c1'))).toBe('die Reise');
    const long: CardFace = { promptPlain: '', answerPlain: '', badges: [], prompt: [block(0, 'x'.repeat(60))], answer: [] };
    expect(cardLabel(long)).toBe(`${'x'.repeat(39)}…`);
    const empty: CardFace = { promptPlain: '', answerPlain: '', badges: [], prompt: [], answer: [] };
    expect(cardLabel(empty)).toBe('Card');
  });
});

describe('sheetFace: a session’s "Card info" never shows the answer before the reveal (wave 5h, device pass E7)', () => {
  /** Every text the layout would draw (headline, subline, rows), as one string. */
  const drawn = (shown: ReturnType<typeof sheetFace>): string =>
    [shown.headline, shown.layout.subline?.plain ?? '', ...shown.layout.rows.map((b) => b.plain)].join(' | ');

  it('without hideAnswer: the whole card, exactly as before (faceLayout, headlineText, the question spoken)', () => {
    const face = faceOf(fixture(), 'c1');
    const shown = sheetFace(face);
    expect(shown.layout).toEqual(faceLayout(face));
    expect(shown.headline).toBe('die Reise');
    expect(shown.spoken).toEqual(speechOf(face, 'prompt'));
    expect(shown.answerHidden).toBe(false);
    expect(drawn(shown)).toContain('the trip');
  });

  it('Basic: the question only — no subline, no answer field; the line says why', () => {
    const face = faceOf(fixture(), 'c1');
    const shown = sheetFace(face, { hideAnswer: true });
    expect(shown.headline).toBe('die Reise');
    expect(shown.layout.subline).toBeNull();
    expect(shown.layout.rows).toEqual([]);
    expect(shown.answerHidden).toBe(true);
    expect(drawn(shown)).not.toContain('the trip');
    expect(drawn(shown)).not.toContain('Die Reise war lang.'); // the Example is on the answer side
    expect(CARD_SHEET_COPY.answerHidden).toBe('The answer shows after you reveal the card.');
    // The reverse direction hides the German side.
    const reverse = sheetFace(faceOf(fixture(), 'c2'), { hideAnswer: true });
    expect(reverse.headline).toBe('the trip');
    expect(drawn(reverse)).not.toContain('die Reise');
  });

  it('a card type with badges: the badges stay (the study card shows them on its front), every answer field goes', () => {
    const type = builtinType('legacyVocabDe', NOW);
    const fields = ['die Reise', 'the trip', 'Die Reise war lang.', 'The trip was long.', '/ˈʁaɪ̯zə/', 'B1', 'noun', 'die', 'Reise', 'Note'];
    const note = noteWithCards({ deckId: 'd1', typeId: type.id, fields, note: { id: 'nv' } }, [type]).note;
    const face = renderFace(note, type, 0);
    const shown = sheetFace(face, { hideAnswer: true });
    expect(shown.headline).toBe('die Reise');
    // Exactly the question's other blocks, then the badges: nothing of the answer side.
    const expected = [...face.prompt.slice(1), ...face.badges].map((b) => b.plain);
    expect(shown.layout.rows.map((b) => b.plain)).toEqual(expected);
    expect(shown.layout.rows.map((b) => b.plain)).toEqual(expect.arrayContaining(['B1', 'noun']));
    for (const answer of ['the trip', 'Die Reise war lang.', 'The trip was long.']) expect(drawn(shown)).not.toContain(answer);
  });

  it('cloze: the question version of the text ("[…]"), never the revealed one', () => {
    const type = builtinType('cloze', NOW);
    const note = noteWithCards(
      { deckId: 'd1', typeId: type.id, fields: ['{{c1::Paris}} is in {{c2::France}}', 'capital'], note: { id: 'nc' } },
      [type],
    ).note;
    const shown = sheetFace(renderFace(note, type, 0), { hideAnswer: true });
    expect(shown.headline).toBe('[…] is in France');
    expect(drawn(shown)).not.toContain('Paris');
  });

  it('a field on both sides keeps its QUESTION version; answer-only fields are left out', () => {
    const face: CardFace = {
      promptPlain: 'q',
      answerPlain: 'a',
      badges: [block(9, 'B1', { role: 'badge' })],
      prompt: [block(0, 'q'), block(1, 'hidden [...]'), block(2, 'pron')],
      answer: [block(3, 'a'), block(1, 'revealed'), block(0, 'q again'), block(4, 'extra')],
    };
    expect(questionLayout(face)).toEqual({ headline: face.prompt[0], subline: null, rows: [face.prompt[1], face.prompt[2], face.badges[0]] });
  });

  it('a dictation question stays its "🔊" (the word it reads aloud IS the answer); 🔊 still speaks the question', () => {
    const speaker: FieldBlock = { field: 0, label: 'Word', role: 'term', lines: [[{ t: 'text', text: '🔊' }]], plain: 'das Haus', lang: 'de-DE' };
    const face: CardFace = {
      promptPlain: '🔊',
      answerPlain: 'das Haus',
      badges: [],
      prompt: [speaker],
      answer: [block(0, 'das Haus'), block(1, 'the house')],
    };
    const shown = sheetFace(face, { hideAnswer: true });
    expect(shown.headline).toBe('🔊');
    expect(drawn(shown)).not.toContain('das Haus');
    expect(drawn(shown)).not.toContain('the house');
    expect(shown.spoken).toEqual({ text: 'das Haus', lang: 'de-DE' });
    // After the reveal (no hideAnswer) the sheet shows the word, as before.
    expect(sheetFace(face).headline).toBe('das Haus');
  });

  it('Articles: the session’s own question (the bare word) replaces the face, with only the badges; 🔊 speaks it', () => {
    const type = builtinType('legacyVocabDe', NOW);
    const fields = ['die Reise', 'the trip', '', '', '', 'B1', 'noun', '', '', ''];
    const note = noteWithCards({ deckId: 'd1', typeId: type.id, fields, note: { id: 'na' } }, [type]).note;
    const face = renderFace(note, type, 0);
    const shown = sheetFace(face, { hideAnswer: true, question: { text: 'Reise', lang: 'de-DE' } });
    expect(shown.headline).toBe('Reise');
    expect(shown.layout.headline).toBeNull(); // no headline block: its text "die Reise" holds the answer
    expect(shown.layout.rows).toEqual(face.badges);
    expect(shown.spoken).toEqual({ text: 'Reise', lang: 'de-DE' });
    expect(shown.answerHidden).toBe(true);
    expect(drawn(shown)).not.toMatch(/\bdie\b/);
    // `question` alone (no hideAnswer) changes nothing: the whole card.
    expect(sheetFace(face, { question: { text: 'Reise' } }).headline).toBe('die Reise');
  });
});

describe('the status line', () => {
  const now = localTime('2026-06-10', '15:00');

  it('nextReviewText: minutes, hours, tomorrow, days (local calendar days)', () => {
    expect(nextReviewText(now - MIN, now)).toBe('due now');
    expect(nextReviewText(now, now)).toBe('due now');
    expect(nextReviewText(now + 10 * MIN, now)).toBe('next in 10 minutes');
    expect(nextReviewText(now + 30 * 1000, now)).toBe('next in 1 minute');
    expect(nextReviewText(now + 3 * HOUR, now)).toBe('next in 3 hours');
    expect(nextReviewText(localTime('2026-06-11', '08:00'), now)).toBe('next tomorrow');
    expect(nextReviewText(localTime('2026-06-14', '00:00'), now)).toBe('next in 4 days');
    expect(nextReviewText(Number.NaN, now)).toBe('due now');
    // 23:30 → 01:00 the next day is "tomorrow", not "in 2 hours".
    expect(nextReviewText(localTime('2026-06-11', '01:00'), localTime('2026-06-10', '23:30'))).toBe('next tomorrow');
  });

  it('cardStatus: the status word (glossary §1.2) and what it means now', () => {
    expect(cardStatus(cardInLifeV3('review', {}, now), null, now).text).toBe('Review · next in 3 days');
    expect(cardStatus(cardInLifeV3('learning', {}, now), null, now).text).toBe('Learning · next in 10 minutes');
    expect(cardStatus(cardInLifeV3('mastered', {}, now), null, now).text).toBe('Mastered · next in 20 days');
    expect(cardStatus(cardInLifeV3('new', {}, now), null, now).text).toBe('New · waiting for its first study');
    expect(cardStatus(cardInLifeV3('notStarted', {}, now), null, now).text).toBe('Not started · not in your study queue');
    expect(cardStatus(cardInLifeV3('known', {}, now), null, now)).toMatchObject({ key: 'known', word: 'Known', text: 'Known' });
  });

  it('says suspended, buried and paused, so "next in 3 days" is never a promise Study does not keep', () => {
    const card = cardInLifeV3('review', { suspended: true, buriedUntil: now + HOUR }, now);
    const status = cardStatus(card, { active: false }, now);
    expect(status.parts).toEqual(['Review', 'next in 3 days', 'suspended', 'buried until tomorrow', 'deck paused']);
    expect(cardStatus(cardInLifeV3('review', { buriedUntil: now - HOUR }, now), { active: true }, now).parts).toEqual([
      'Review',
      'next in 3 days',
    ]);
  });

  it('a long wait: months and years, the same number as the Library row (wave 5i)', () => {
    expect(nextReviewText(addLocalDays(now, 29), now)).toBe('next in 29 days');
    expect(nextReviewText(addLocalDays(now, 45), now)).toBe('next in 2 months');
    expect(nextReviewText(addLocalDays(now, 400), now)).toBe('next in 1.1 years');
    expect(nextReviewText(addLocalDays(now, 365), now)).toBe('next in 1 year');
  });

  it('deckPath: deck › section parts', () => {
    expect(deckPath({ name: 'German' }, 'Vocabulary::B1')).toBe('German › Vocabulary › B1');
    expect(deckPath({ name: 'German' }, '')).toBe('German');
    expect(deckPath({ name: 'German' }, ' Verbs :: ::B2 ')).toBe('German › Verbs › B2');
    expect(deckPath(null, undefined)).toBe('No deck');
  });
});

// Wave 5i (release re-measure, die Erfahrung): at the same moment the Library row said
// "Review · next 4d" and this sheet "Review · next in 3 days". The row rounded the time left,
// the sheet counted calendar days. Now ONE function (src/utils/dateFormatting.ts reviewWait)
// gives both: the words may differ, the number never does.
describe('one due text: the Library row and the CardSheet say the same number (wave 5i)', () => {
  /** The number and unit of a short text: "next 4d" → [4, 'day']; "due" → null. */
  function shortParts(text: string): [number, string] | null {
    if (text === 'due') return null;
    const m = /^next (\d+(?:\.\d+)?)(m|h|d|mo|y)$/.exec(text);
    if (!m) throw new Error(`not a short due text: ${text}`);
    const unit = { m: 'minute', h: 'hour', d: 'day', mo: 'month', y: 'year' }[m[2]] as string;
    return [Number(m[1]), unit];
  }
  /** The number and unit of a long text: "next in 4 days" → [4, 'day']; "next tomorrow" → [1, 'day']. */
  function longParts(text: string): [number, string] | null {
    if (text === 'due now') return null;
    if (text === 'next tomorrow') return [1, 'day'];
    const m = /^next in ([\d,]+(?:\.\d+)?) (minute|hour|day|month|year)s?$/.exec(text);
    if (!m) throw new Error(`not a long due text: ${text}`);
    return [Number(m[1].replace(/,/g, '')), m[2]];
  }

  it('the release pair: rated at 22:45 with 4 days, seen at 09:18 the next morning → 3 in both', () => {
    const rated = localTime('2026-10-23', '22:45');
    const due = rated + 4 * DAY;
    const seen = localTime('2026-10-24', '09:18');
    const card: Card = { ...cardInLifeV3('review', {}, seen), due, intervalDays: 4 };
    expect(rowStatus(card, seen).text).toBe('Review · next 3d');
    expect(cardStatus(card, null, seen).text).toBe('Review · next in 3 days');
  });

  it('around midnight: the calendar day decides, the hour or minute before it', () => {
    const late = localTime('2026-06-10', '23:30');
    // 23:30 → 01:00 the next day: tomorrow in both (not "2h" in the row).
    const oneAm = localTime('2026-06-11', '01:00');
    expect(nextReviewShort(oneAm, late)).toBe('next 1d');
    expect(nextReviewLong(oneAm, late)).toBe('next tomorrow');
    // Less than an hour left: minutes, also across midnight.
    const tenPast = localTime('2026-06-11', '00:10');
    expect(nextReviewShort(tenPast, late)).toBe('next 40m');
    expect(nextReviewLong(tenPast, late)).toBe('next in 40 minutes');
    // The same day: hours.
    const morning = localTime('2026-06-10', '06:00');
    expect(nextReviewShort(late, morning)).toBe('next 18h');
    expect(nextReviewLong(late, morning)).toBe('next in 18 hours');
    // 3 days and 23 hours left, but the card comes on the 3rd day after today: 3 in both (the old row said "4d").
    const justAfter = localTime('2026-06-10', '00:30');
    const due = localTime('2026-06-14', '00:00') - MIN;
    expect(nextReviewShort(due, justAfter)).toBe('next 3d');
    expect(nextReviewLong(due, justAfter)).toBe('next in 3 days');
    // 3.1 days left, crossing 4 midnights: 4 in both (the old row said "3d").
    const beforeMidnight = localTime('2026-06-10', '23:50');
    const dueAt2 = localTime('2026-06-14', '02:00');
    expect(nextReviewShort(dueAt2, beforeMidnight)).toBe('next 4d');
    expect(nextReviewLong(dueAt2, beforeMidnight)).toBe('next in 4 days');
    // 10 minutes later the new day has begun: 3 in both.
    const afterMidnight = localTime('2026-06-11', '00:00');
    expect(nextReviewShort(dueAt2, afterMidnight)).toBe('next 3d');
    expect(nextReviewLong(dueAt2, afterMidnight)).toBe('next in 3 days');
  });

  it('due, no due time, and a day that is 23 or 25 hours long (DST) still count right', () => {
    const now = localTime('2026-06-10', '15:00');
    expect(nextReviewShort(now, now)).toBe('due');
    expect(nextReviewLong(now, now)).toBe('due now');
    expect(nextReviewShort(Number.NaN, now)).toBe('due');
    expect(reviewWait(now + MIN, Number.NaN)).toBeNull();
    // The same wall-clock time a few days later is that many days, over both DST switches of 2026
    // (Europe 29 March / 25 October, USA 8 March / 1 November), whatever zone the test runs in.
    for (const start of ['2026-03-07', '2026-03-28', '2026-10-24', '2026-10-31']) {
      const t = localTime(start, '12:00');
      expect(reviewWait(sameClockDaysLater(t, 1), t)).toEqual({ n: 1, unit: 'day' });
      expect(reviewWait(sameClockDaysLater(t, 3), t)).toEqual({ n: 3, unit: 'day' });
    }
  });

  it('a sweep over times of day and waits: the short and the long text always have the same number', () => {
    const waits = [30 * 1000, 5 * MIN, 59 * MIN, HOUR, 90 * MIN, 5 * HOUR, 11 * HOUR, 20 * HOUR, DAY, 1.5 * DAY, 3.6 * DAY, 4 * DAY, 29.5 * DAY, 45 * DAY, 200 * DAY, 400 * DAY];
    let checked = 0;
    for (let day = 0; day < 3; day++) {
      for (let minute = 0; minute < 24 * 60; minute += 25) {
        const now = addLocalDays(localTime('2026-06-10', '00:00'), day) + minute * MIN;
        for (const wait of waits) {
          const due = now + wait;
          const short = shortParts(nextReviewShort(due, now));
          const long = longParts(nextReviewLong(due, now));
          expect(short).toEqual(long);
          const w = reviewWait(due, now);
          expect(short).toEqual(w ? [w.n, w.unit] : null);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(2000);
  });

  it('the Library row and the sheet read the SAME function (rowStatus and cardStatus)', () => {
    const now = localTime('2026-06-10', '21:00');
    for (const due of [now + 20 * MIN, now + 2 * HOUR, now + 5 * HOUR, now + 3.6 * DAY, now + 60 * DAY]) {
      const card: Card = { ...cardInLifeV3('review', {}, now), due };
      expect(rowStatus(card, now).text).toBe(`Review · ${nextReviewShort(due, now)}`);
      expect(cardStatus(card, null, now).text).toBe(`Review · ${nextReviewLong(due, now)}`);
    }
  });
});

describe('tags', () => {
  it('visibleTags: as stored, without empty or repeated ones; chip labels show the hierarchy', () => {
    expect(visibleTags(['Travel', ' ', 'Travel', 'A::B', ''])).toEqual(['Travel', 'A::B']);
    expect(visibleTags(undefined)).toEqual([]);
    expect(tagChipLabel('Algo::Core_Patterns')).toBe('Algo › Core_Patterns');
  });

  it('a tag chip opens the Library with ONE Tag chip and a fresh nonce (spec §4.6, §7 #49)', () => {
    const href = libraryTagHref('Algo::Core_Patterns', '1700000000000');
    expect(href.startsWith('/(tabs)/library?q=')).toBe(true);
    const params = new URLSearchParams(href.slice(href.indexOf('?') + 1));
    expect(params.get('nonce')).toBe('1700000000000');
    // The query is the clean JSON of { tags: [tag] } (folded like the note tags it is compared with).
    expect(parseQueryParam(params.get('q'))).toEqual({ tags: ['algo::core_patterns'] });
    expect(libraryTagHref('Travel', '5')).toBe(`/(tabs)/library?q=${encodeURIComponent('{"tags":["travel"]}')}&nonce=5`);
  });
});

describe('Favorite / Flag / Suspend toggles', () => {
  it('the label is the ACTION, the icon and `on` the state: a flagged card shows "Unflag"', () => {
    const plain = flagToggles({});
    expect(plain.map((t) => [t.key, t.label, t.icon, t.on])).toEqual([
      ['fav', 'Favorite', 'heart-outline', false],
      ['flagged', 'Flag', 'flag-outline', false],
      ['suspended', 'Suspend', 'pause-circle-outline', false],
    ]);
    const all = flagToggles({ fav: true, flagged: true, suspended: true });
    expect(all.map((t) => [t.label, t.icon, t.on, t.name])).toEqual([
      ['Unfavorite', 'heart', true, 'Favorite'],
      ['Unflag', 'flag', true, 'Flag'],
      ['Unsuspend', 'pause-circle', true, 'Suspend'],
    ]);
  });

  it('flagPatch flips one marker only; flagSnack says what happened', () => {
    expect(flagPatch({ flagged: true }, 'flagged')).toEqual({ flagged: false });
    expect(flagPatch({}, 'fav')).toEqual({ fav: true });
    expect(flagPatch({ suspended: false }, 'suspended')).toEqual({ suspended: true });
    expect([flagSnack('fav', true), flagSnack('fav', false)]).toEqual(['Added to Favorites', 'Removed from Favorites']);
    expect([flagSnack('flagged', true), flagSnack('flagged', false)]).toEqual(['Flagged', 'Unflagged']);
    expect([flagSnack('suspended', true), flagSnack('suspended', false)]).toEqual(['Suspended', 'Unsuspended']);
  });
});

describe('the Status control', () => {
  it('"Not started" is offered only for a card that was never studied', () => {
    expect(statusSegments(cardInLifeV3('notStarted')).map((s) => s.label)).toEqual(['Not started', 'In queue', 'Known']);
    expect(statusSegments(cardInLifeV3('new')).map((s) => s.label)).toEqual(['Not started', 'In queue', 'Known']);
    expect(statusSegments(cardInLifeV3('known')).map((s) => s.label)).toEqual(['Not started', 'In queue', 'Known']);
    expect(statusSegments(cardInLifeV3('review')).map((s) => s.label)).toEqual(['In queue', 'Known']);
    expect(statusSegments(cardInLifeV3('learning')).map((s) => s.id)).toEqual(['queue', 'known']);
  });

  it('the selected segment: Known, Not started, or In queue for every other status', () => {
    expect(statusSegmentOf(cardInLifeV3('known'))).toBe('known');
    expect(statusSegmentOf(cardInLifeV3('review', { knownAt: NOW }))).toBe('known');
    expect(statusSegmentOf(cardInLifeV3('notStarted'))).toBe('notStarted');
    for (const kind of ['new', 'learning', 'review', 'mastered'] as const) expect(statusSegmentOf(cardInLifeV3(kind))).toBe('queue');
  });

  it('what a tap does', () => {
    const notStarted = cardInLifeV3('notStarted');
    const fresh = cardInLifeV3('new');
    const known = cardInLifeV3('known');
    const review = cardInLifeV3('review');
    expect(statusChange(notStarted, 'queue')).toEqual({ command: 'learn', snack: 'Added to your queue' });
    expect(statusChange(notStarted, 'known')).toEqual({ command: 'markKnown', snack: 'Marked as known' });
    expect(statusChange(fresh, 'notStarted')).toEqual({ command: 'setNotStarted', snack: 'Moved back to Not started' });
    expect(statusChange(known, 'queue')).toEqual({ command: 'learn', snack: 'No longer marked as known' });
    expect(statusChange(known, 'notStarted')).toEqual({ command: 'setNotStarted', snack: 'Moved back to Not started' });
    expect(statusChange(review, 'known')).toEqual({ command: 'markKnown', snack: 'Marked as known' });
    // No-ops: the same segment, and Not started for a studied card.
    expect(statusChange(review, 'queue')).toBeNull();
    expect(statusChange(known, 'known')).toBeNull();
    expect(statusChange(review, 'notStarted')).toBeNull();
    expect(statusChange(cardInLifeV3('review', { knownAt: NOW }), 'notStarted')).toBeNull();
    expect(isStatusSegment('queue')).toBe(true);
    expect(isStatusSegment('learning')).toBe(false);
  });

  it('each command really lands the card in the chosen segment (real reducer)', () => {
    const state = fixture(lifeValues('new', NOW));
    const ctx = testCtx(NOW);
    const notStarted = reducer.setNotStarted(state, { cardIds: ['c1'] }, ctx).state;
    expect(statusSegmentOf(notStarted.cards.find((c) => c.id === 'c1')!)).toBe('notStarted');
    const known = reducer.markKnown(notStarted, { cardIds: ['c1'] }, ctx).state;
    expect(statusSegmentOf(known.cards.find((c) => c.id === 'c1')!)).toBe('known');
    const queued = reducer.learn(known, { cardIds: ['c1'] }, ctx).state;
    expect(statusSegmentOf(queued.cards.find((c) => c.id === 'c1')!)).toBe('queue');
    // Only this direction changed: the sibling stays where it was.
    expect(queued.cards.find((c) => c.id === 'c2')).toBe(state.cards.find((c) => c.id === 'c2'));
  });
});

describe('which rows show', () => {
  it('the full sheet: every edit row; Reset only with progress; Reschedule only with a schedule', () => {
    expect(cardSheetSections(cardInLifeV3('review'), { practiceCount: 1 })).toEqual({
      edit: true,
      reset: true,
      reschedule: 'offer',
      practice: true,
      tagsTappable: true,
      info: false,
    });
    expect(cardSheetSections(cardInLifeV3('new'), { practiceCount: 1 })).toMatchObject({
      reset: false,
      reschedule: 'notStudied',
    });
    expect(cardSheetSections(cardInLifeV3('notStarted'), { practiceCount: 0 })).toMatchObject({
      reset: false,
      reschedule: 'notStudied',
      practice: false,
    });
    // Known with no study: Reset clears Known; still nothing to reschedule.
    expect(cardSheetSections(cardInLifeV3('known'), { practiceCount: 0 })).toMatchObject({
      reset: true,
      reschedule: 'notStudied',
    });
  });

  it('read-only (session "Card info"): no edit rows, no Library jumps, the info rows instead', () => {
    expect(cardSheetSections(cardInLifeV3('review'), { readOnly: true, practiceCount: 1 })).toEqual({
      edit: false,
      reset: false,
      reschedule: null,
      practice: false,
      tagsTappable: false,
      info: true,
    });
  });

  it('"Practice this card" opens a session that really holds the card (and is hidden when it would not)', () => {
    const state = fixture();
    const ctx = matchCtxOf(state, NOW);
    expect(buildSessionQueue({ kind: 'practice', sel: ['c1'] }, state, ctx).map((c) => c.id)).toEqual(['c1']);
    // A Known card is not practised: the count is 0 and the row is hidden (no empty session).
    const known = fixture({ knownAt: NOW - DAY });
    const count = buildSessionQueue({ kind: 'practice', sel: ['c1'] }, known, matchCtxOf(known, NOW)).length;
    expect(count).toBe(0);
    expect(cardSheetSections(known.cards[0], { practiceCount: count }).practice).toBe(false);
  });

  it('infoRows: card type, direction (with languages), repetitions, lapses, ease', () => {
    const state = fixture();
    expect(infoRows(cardSheetSourceOf(state, 'c1')!)).toEqual([
      { label: 'Card type', value: 'Basic + reverse' },
      { label: 'Direction', value: 'German → English' },
      { label: 'Repetitions', value: '4' },
      { label: 'Lapses', value: '1' },
      { label: 'Ease', value: '235%' },
    ]);
    expect(infoRows(cardSheetSourceOf(state, 'c2')!)[1]).toEqual({ label: 'Direction', value: 'English → German' });
  });

  it('infoRows: the Lapses row says why when it differs from the lapses of the History line', () => {
    const source = cardSheetSourceOf(fixture(), 'c1')!; // card.lapses = 1
    const lapsesRow = (historyLapses: number | null) => infoRows(source, historyLapses).find((r) => r.label === 'Lapses');
    // No count in a History line, or the same number: no note.
    expect(lapsesRow(null)).toEqual({ label: 'Lapses', value: '1' });
    expect(lapsesRow(1)).toEqual({ label: 'Lapses', value: '1' });
    // More than the History: the scheduler's count also holds lapses from Anki (or from before the history).
    expect(lapsesRow(0)).toEqual({ label: 'Lapses', value: '1', note: LAPSES_MORE_NOTE });
    // Fewer: "Reset progress…" set the count back to 0, and the History kept the older reviews.
    expect(lapsesRow(3)).toEqual({ label: 'Lapses', value: '1', note: LAPSES_FEWER_NOTE });
    // The exact words.
    expect(LAPSES_MORE_NOTE).toBe('Includes lapses the History below does not show, for example from Anki');
    expect(LAPSES_FEWER_NOTE).toBe('Counted since the last reset. The History below also has older reviews');
    // Broken numbers: no note (never a wrong one).
    expect(lapsesNote(Number.NaN, 1)).toBeNull();
    expect(lapsesNote(1, Number.NaN)).toBeNull();
    // The other rows never get a note.
    expect(infoRows(source, 0).filter((r) => r.note !== undefined).map((r) => r.label)).toEqual(['Lapses']);
  });

  it('historyLapsesOf: the lapse count of the History line, null when the line shows none', () => {
    expect(historyLapsesOf(null)).toBeNull(); // not read yet
    expect(historyLapsesOf([])).toBeNull(); // "no reviews in Maranki yet", or no line
    const rows = [row(1, { ivlBefore: 10, ivlAfter: 20 }), row(2, { ivlBefore: 20, ivlAfter: 10, rating: 'again', easeAfter: 2.3 })];
    expect(historyLapsesOf(rows)).toBe(1);
    expect(historyLineOf(rows, { reps: 2 }, NOW)).toContain(' · 1 lapse · ');
  });
});

describe('the History line (lapses from the history rows only)', () => {
  it('reviews, lapses and the last rating, from the rows', () => {
    const rows = [
      row(1, { bucket: 'new', ivlBefore: 0, ivlAfter: 0, rating: 'good' }),
      row(2, { ivlBefore: 0, ivlAfter: 1, rating: 'good' }),
      row(3, { ivlBefore: 1, ivlAfter: 3, rating: 'good' }),
      row(4, { ivlBefore: 3, ivlAfter: 2, rating: 'again', easeAfter: 2.3, atMs: NOW - 3 * DAY }),
    ];
    expect(revlogLapseCount(rows)).toBe(1);
    expect(historyLineOf(rows, { reps: 4 }, NOW)).toBe('History: 4 reviews · 1 lapse · last: 3 days ago (Again)');
    // No rows and never studied: there really are no reviews.
    expect(historyLineOf([], { reps: 0 }, NOW)).toBe(CARD_SHEET_COPY.noHistory);
    expect(CARD_SHEET_COPY.noHistory).toBe('History: no reviews in Maranki yet');
  });

  it('no rows for a STUDIED card (before the review history existed, or imported): no History line, never "no reviews"', () => {
    // An upgraded v2 card studied 30 times in Maranki: the revlog started later and kept only the last 400 ratings.
    expect(historyLineOf([], { reps: 30 }, NOW)).toBeNull();
    expect(historyLineOf([], { reps: 1 }, NOW)).toBeNull();
    // Some rows: the line counts what the rows hold.
    expect(historyLineOf([row(1, { atMs: NOW - DAY })], { reps: 30 }, NOW)).toBe(
      'History: 1 review · 0 lapses · last: yesterday (Good)',
    );
  });

  it('an Again in Learning or Relearning is not a lapse; the rows may come in any order', () => {
    const rows = [
      row(2, { ivlBefore: 0, ivlAfter: 0, rating: 'again' }), // still learning a new card
      row(3, { ivlBefore: 4, ivlAfter: 2, rating: 'again', easeAfter: 2.3 }), // lapse (interval cut)
      row(4, { ivlBefore: 2, ivlAfter: 2, rating: 'again', easeAfter: 2.3 }), // relearning: same interval, same ease
      row(1, { bucket: 'new', ivlBefore: 0, ivlAfter: 0, rating: 'again' }),
    ];
    expect(revlogLapseCount(rows)).toBe(1);
  });

  it('a lapse that keeps the interval (1 day) is found by the lower ease; the first row of an imported card counts only when the interval was cut', () => {
    expect(revlogLapseCount([row(1, { ivlBefore: 1, ivlAfter: 1, easeAfter: 2.5 }), row(2, { ivlBefore: 1, ivlAfter: 1, rating: 'again', easeAfter: 2.3 })])).toBe(1);
    // An imported Review card: its first Again in Maranki cuts the interval → a lapse.
    expect(revlogLapseCount([row(1, { ivlBefore: 12, ivlAfter: 6, rating: 'again', easeAfter: 2.3 })])).toBe(1);
    // An imported RELEARNING card (Anki type 3: stepIndex 0 with its interval): Again keeps the
    // interval and the ease, and the scheduler counts no lapse — so neither does the History line.
    expect(revlogLapseCount([row(1, { ivlBefore: 12, ivlAfter: 12, rating: 'again', easeAfter: 2.5 })])).toBe(0);
  });

  it('a missed Check (Again or Hard) of a studied card is a lapse; of a never-studied Known card it is not', () => {
    expect(revlogLapseCount([row(1, { bucket: 'check', ivlBefore: 30, ivlAfter: 30, rating: 'hard' })])).toBe(1);
    expect(revlogLapseCount([row(1, { bucket: 'check', ivlBefore: 0, ivlAfter: 0, rating: 'again' })])).toBe(0);
    expect(revlogLapseCount([row(1, { bucket: 'check', ivlBefore: 30, ivlAfter: 30, rating: 'good' })])).toBe(0);
  });

  it('matches the real scheduler’s lapse count on 300 random rating runs (except a 1-day lapse at the lowest ease)', () => {
    const rnd = createRandom('card-sheet-lapses');
    const ratings: Rating[] = ['again', 'hard', 'good', 'easy'];
    for (let run = 0; run < 300; run += 1) {
      let card = cardInLifeV3('new', { id: 'c1', lapses: 0 }, NOW);
      let t = NOW;
      const rows: RevlogRow[] = [];
      let unseen = 0;
      const length = rnd.int(1, 40);
      for (let i = 0; i < length; i += 1) {
        const rating = rnd.pick(ratings);
        const bucket = reducer.reviewBucket(card);
        const next = applyRating(card, rating, DEFAULT_SRS, t);
        if (next.lapses > card.lapses && next.ease === card.ease && next.intervalDays === card.intervalDays) unseen += 1;
        rows.push(
          row(i + 1, { atMs: t, rating, bucket, ivlBefore: card.intervalDays, ivlAfter: next.intervalDays, easeAfter: next.ease }),
        );
        card = next;
        t += rnd.int(1, 5 * 24) * HOUR;
      }
      expect(revlogLapseCount(rnd.shuffle(rows))).toBe(card.lapses - unseen);
    }
  });

  it('IMPORTED cards (Review, or Relearning with an interval) match the real scheduler on 300 random runs', () => {
    const rnd = createRandom('card-sheet-lapses-imported');
    const ratings: Rating[] = ['again', 'hard', 'good', 'easy'];
    for (let run = 0; run < 300; run += 1) {
      // What ankiSrs.ts makes of an Anki card: type 2 → stepIndex null; type 3 → stepIndex 0 with its interval.
      const relearning = rnd.int(0, 1) === 1;
      let card = cardInLifeV3(
        'review',
        {
          id: 'c1',
          reps: rnd.int(1, 40),
          lapses: rnd.int(0, 5),
          stepIndex: relearning ? 0 : null,
          intervalDays: relearning ? rnd.int(0, 60) : rnd.int(1, 60),
          ease: 1.3 + rnd.int(0, 15) / 10,
        },
        NOW,
      );
      const lapsesBefore = card.lapses;
      let t = NOW;
      const rows: RevlogRow[] = [];
      let unseen = 0;
      const length = rnd.int(1, 30);
      for (let i = 0; i < length; i += 1) {
        const rating = rnd.pick(ratings);
        const bucket = reducer.reviewBucket(card);
        const next = applyRating(card, rating, DEFAULT_SRS, t);
        // A lapse that keeps the interval cannot be seen in the FIRST row (no ease before it),
        // and in a later row only by a lower ease.
        const lapsed = next.lapses > card.lapses;
        if (lapsed && next.intervalDays === card.intervalDays && (i === 0 || next.ease === card.ease)) unseen += 1;
        rows.push(
          row(i + 1, { atMs: t, rating, bucket, ivlBefore: card.intervalDays, ivlAfter: next.intervalDays, easeAfter: next.ease }),
        );
        card = next;
        t += rnd.int(1, 5 * 24) * HOUR;
      }
      expect(revlogLapseCount(rnd.shuffle(rows))).toBe(card.lapses - lapsesBefore - unseen);
    }
  });
});

describe('the other rows: copy and routes', () => {
  it('Delete says it deletes every direction (the card editor’s words)', () => {
    expect(deleteRowSub(1)).toBe('Its study progress goes with it');
    expect(deleteRowSub(2)).toBe('Deletes both directions and their progress');
    expect(deleteRowSub(3)).toBe('Deletes all 3 directions and their progress');
    expect(deleteConfirmBody('die Reise', 1)).toBe('“die Reise” and its study progress will be removed.');
    expect(deleteConfirmBody('die Reise', 2)).toBe('“die Reise” and its study progress will be removed. This deletes both directions of it.');
    expect(deleteConfirmBody('x', 4)).toBe('“x” and its study progress will be removed. This deletes all 4 directions of it.');
    expect(deleteSnack('die Reise')).toBe('“die Reise” deleted');
  });

  it('Move says how many directions moved', () => {
    expect(moveSnack('Spanish', 1)).toBe('Moved to Spanish');
    expect(moveSnack('Spanish', 2)).toBe('Both directions moved to Spanish');
    expect(moveSnack('Spanish', 3)).toBe('All 3 directions moved to Spanish');
  });

  it('Reset uses the spec’s question', () => {
    expect(CARD_SHEET_COPY.resetTitle).toBe('Start this card again as New?');
    expect(CARD_SHEET_COPY.resetBody).toBe('Its history is kept.');
  });

  it('Edit opens the card editor on the NOTE; Practice opens a practice session by selection token', () => {
    expect(editCardRoute('n1')).toEqual({ pathname: '/card-editor', params: { noteId: 'n1' } });
    expect(practiceRoute('sel-1', 'die Reise')).toEqual({
      pathname: '/session',
      params: { kind: 'practice', sel: 'sel-1', label: 'die Reise' },
    });
  });
});

/* ================================================================ part 2: the component */

let renderer: ReactTestRenderer | null = null;

/**
 * The component reads the REAL clock (useNow), so its cards are built
 * around the real time: due in 3 days from now really is "next in 3 days".
 */
const LIVE = Date.now();

beforeEach(() => {
  mockState = fixture({ flagged: true }, LIVE);
  mockPracticeCount = 1;
  mockHistoryRows = [];
  mockHistoryReady = false;
  mockDeleted.clear();
  mockSnackChannel.snack = null;
});

afterEach(() => {
  if (renderer) act(() => renderer!.unmount());
  renderer = null;
  jest.clearAllMocks();
});

interface Props {
  cardId: string | null;
  open: boolean;
  onClose: () => void;
  readOnly?: boolean;
  hideAnswer?: boolean;
  question?: SpokenText;
}

function render(props: Partial<Props> = {}): { r: ReactTestRenderer; onClose: jest.Mock<() => void> } {
  const onClose = jest.fn<() => void>();
  const all: Props = { cardId: 'c1', open: true, onClose, ...props };
  act(() => {
    renderer = TestRenderer.create(React.createElement(CardSheet, all));
  });
  return { r: renderer!, onClose };
}

/** Render again with the same props (the mocked store has no subscription: a change needs a re-render). */
function rerender(r: ReactTestRenderer, props: Partial<Props> = {}) {
  const current = r.root.findByType(CardSheet).props as Props;
  act(() => r.update(React.createElement(CardSheet, { ...current, ...props })));
}

/** Every text on screen, joined (host Text nodes only). */
function texts(r: ReactTestRenderer): string[] {
  return r.root
    .findAll((n) => (n.type as unknown) === 'Text')
    .map((n) => (Array.isArray(n.props.children) ? n.props.children.join('') : String(n.props.children ?? '')));
}

/** The pressable (composite, with onPress) with this screen-reader label. */
function byLabel(r: ReactTestRenderer, label: string): ReactTestInstance | undefined {
  return r.root.findAll((n) => typeof n.type !== 'string' && n.props.accessibilityLabel === label && typeof n.props.onPress === 'function')[0];
}

/** The nearest pressable around the text `text`. */
function byText(r: ReactTestRenderer, text: string): ReactTestInstance {
  const node = r.root.findAll((n) => (n.type as unknown) === 'Text' && n.props.children === text)[0];
  if (!node) throw new Error(`no text ${text}`);
  let at: ReactTestInstance | null = node;
  while (at && typeof at.props.onPress !== 'function') at = at.parent;
  if (!at) throw new Error(`no pressable around ${text}`);
  return at;
}

/** The host switch of a toggle. */
function hostSwitch(r: ReactTestRenderer, name: string): ReactTestInstance {
  return r.root.findAll((n) => typeof n.type === 'string' && n.props.accessibilityRole === 'switch' && n.props.accessibilityLabel === name)[0];
}

/** The snackbar Undo of the last show() call. */
function lastUndo(): () => void {
  const call = mockShow.mock.calls[mockShow.mock.calls.length - 1];
  const action = call?.[1];
  if (!action) throw new Error('the last snackbar had no Undo');
  return action.onAction;
}

describe('CardSheet (the component)', () => {
  it('shows the face, the status, the deck › section and the tags', () => {
    const { r } = render();
    const all = texts(r);
    expect(all).toEqual(expect.arrayContaining(['die Reise', 'the trip', 'Review · next in 3 days', '🇩🇪 German › Vocabulary › B1']));
    expect(all).toEqual(expect.arrayContaining(['Travel', 'Algo › Core_Patterns']));
  });

  it('the flag state is visible: a flagged card shows "Unflag", its switch is on; Favorite is off', () => {
    const { r } = render();
    expect(hostSwitch(r, 'Flag').props.accessibilityState).toEqual({ checked: true });
    expect(hostSwitch(r, 'Favorite').props.accessibilityState).toEqual({ checked: false });
    expect(texts(r)).toEqual(expect.arrayContaining(['Unflag', 'Favorite', 'Suspend']));
  });

  it('a toggle writes setFlags, flips in place (the sheet stays open), and its Undo takes it back', () => {
    const { r, onClose } = render();
    act(() => byLabel(r, 'Flag')!.props.onPress());
    expect(mockActions.setFlags).toHaveBeenCalledWith(['c1'], { flagged: false });
    expect(mockShow).toHaveBeenLastCalledWith('Unflagged', expect.objectContaining({ onAction: expect.any(Function) }));
    expect(onClose).not.toHaveBeenCalled();
    rerender(r);
    expect(hostSwitch(r, 'Flag').props.accessibilityState).toEqual({ checked: false });
    expect(texts(r)).toContain('Flag');

    act(() => lastUndo()());
    expect(mockActions.undoManualEdit).toHaveBeenCalledTimes(1);
    expect(mockState.cards.find((c) => c.id === 'c1')?.flagged).toBe(true);
    rerender(r);
    expect(texts(r)).toContain('Unflag');
  });

  it('Status: a studied card has no "Not started"; "Known" calls markKnown with a snackbar Undo', () => {
    const { r } = render();
    // The SegCtrl options are radio buttons with `checked` (wave 5e F1-4; they were "tab"s with `selected`).
    const tabs = r.root.findAll((n) => typeof n.type === 'string' && n.props.accessibilityRole === 'radio');
    expect(tabs.map((t) => [t.props.accessibilityLabel, t.props.accessibilityState.checked])).toEqual([
      ['In queue', true],
      ['Known', false],
    ]);
    act(() => byLabel(r, 'Known')!.props.onPress());
    expect(mockActions.markKnown).toHaveBeenCalledWith(['c1']);
    expect(mockShow).toHaveBeenLastCalledWith('Marked as known', expect.objectContaining({ onAction: expect.any(Function) }));
    act(() => lastUndo()());
    expect(mockState.cards.find((c) => c.id === 'c1')?.knownAt ?? null).toBeNull();
  });

  it('Reset progress… asks first, then resets with Undo', () => {
    const { r } = render();
    act(() => byText(r, CARD_SHEET_COPY.reset).props.onPress());
    expect(texts(r)).toEqual(expect.arrayContaining([CARD_SHEET_COPY.resetTitle, CARD_SHEET_COPY.resetBody]));
    expect(mockActions.resetProgress).not.toHaveBeenCalled();
    act(() => byText(r, CARD_SHEET_COPY.resetConfirm).props.onPress());
    expect(mockActions.resetProgress).toHaveBeenCalledWith(['c1']);
    expect(mockState.cards.find((c) => c.id === 'c1')?.reps).toBe(0);
    expect(mockShow).toHaveBeenLastCalledWith('Reset to New', expect.objectContaining({ onAction: expect.any(Function) }));
  });

  it('a New card: no Reset, and "Not studied yet — nothing to reschedule" instead of Reschedule…', () => {
    mockState = fixture(lifeValues('new', LIVE), LIVE);
    const { r } = render();
    const all = texts(r);
    expect(all).not.toContain(CARD_SHEET_COPY.reset);
    expect(all).not.toContain(CARD_SHEET_COPY.reschedule);
    expect(all).toContain('Not studied yet — nothing to reschedule');
    // A never-studied card can go back to Not started.
    expect(byLabel(r, 'Not started')).toBeDefined();
  });

  it('Delete card… asks first (all directions), deletes the note, closes, and Undo brings it back', () => {
    const { r, onClose } = render();
    expect(texts(r)).toContain('Deletes both directions and their progress');
    act(() => byText(r, CARD_SHEET_COPY.delete).props.onPress());
    expect(texts(r)).toContain('“die Reise” and its study progress will be removed. This deletes both directions of it.');
    act(() => byText(r, CARD_SHEET_COPY.deleteConfirm).props.onPress());
    expect(mockActions.deleteNotes).toHaveBeenCalledWith(['n1']);
    expect(mockState.cards).toHaveLength(0);
    expect(onClose).toHaveBeenCalled();
    expect(mockShow).toHaveBeenLastCalledWith('“die Reise” deleted', expect.objectContaining({ onAction: expect.any(Function) }));
    // The sheet keeps the deleted card while it slides out (no crash, no empty flash).
    rerender(r, { open: false });
    expect(texts(r)).toContain('die Reise');
    act(() => lastUndo()());
    expect(mockActions.undoDelete).toHaveBeenCalledWith('del-1');
    expect(mockState.cards.map((c) => c.id).sort()).toEqual(['c1', 'c2']);
  });

  it('Move to deck… moves the whole note and offers Undo', () => {
    const { r } = render();
    act(() => byText(r, CARD_SHEET_COPY.move).props.onPress());
    act(() => byText(r, 'Spanish').props.onPress());
    expect(mockActions.moveNotes).toHaveBeenCalledWith(['n1'], 'd2');
    expect(mockState.cards.every((c) => c.deckId === 'd2')).toBe(true);
    expect(mockShow).toHaveBeenLastCalledWith('Both directions moved to Spanish', expect.objectContaining({ onAction: expect.any(Function) }));
    act(() => lastUndo()());
    expect(mockState.cards.every((c) => c.deckId === 'd1')).toBe(true);
  });

  it('a tag chip closes the sheet and opens the Library with that Tag chip', () => {
    const { r, onClose } = render();
    act(() => byLabel(r, 'Tag: Travel')!.props.onPress());
    expect(onClose).toHaveBeenCalled();
    const href = String(mockPush.mock.calls[0][0]);
    expect(href.startsWith('/(tabs)/library?q=')).toBe(true);
    expect(parseQueryParam(new URLSearchParams(href.split('?')[1]).get('q'))).toEqual({ tags: ['travel'] });
  });

  it('Edit card opens the card editor on the note; Practice this card opens a practice session of this card only', () => {
    const { r } = render();
    act(() => byText(r, CARD_SHEET_COPY.edit).props.onPress());
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/card-editor', params: { noteId: 'n1' } });
    act(() => byText(r, CARD_SHEET_COPY.practice).props.onPress());
    const route = mockPush.mock.calls[mockPush.mock.calls.length - 1][0] as ReturnType<typeof practiceRoute>;
    expect(route.pathname).toBe('/session');
    expect(route.params.kind).toBe('practice');
    expect(getSelection(route.params.sel)).toEqual(['c1']);
  });

  it('Practice this card is hidden when the practice session would be empty', () => {
    mockPracticeCount = 0;
    const { r } = render();
    expect(texts(r)).not.toContain(CARD_SHEET_COPY.practice);
  });

  it('read-only (session "Card info"): no toggles or edit rows; card type, direction, repetitions, lapses, ease', () => {
    const { r } = render({ readOnly: true });
    expect(r.root.findAll((n) => typeof n.type === 'string' && n.props.accessibilityRole === 'switch')).toHaveLength(0);
    const all = texts(r);
    for (const hidden of [CARD_SHEET_COPY.edit, CARD_SHEET_COPY.delete, CARD_SHEET_COPY.move, CARD_SHEET_COPY.practice, CARD_SHEET_COPY.reset]) {
      expect(all).not.toContain(hidden);
    }
    expect(all).toEqual(expect.arrayContaining(['Basic + reverse', 'German → English', '4', '235%']));
    // Tags are plain pills: no jump out of the session.
    expect(byLabel(r, 'Tag: Travel')).toBeUndefined();
  });

  it('shows the History line once the review history is read', async () => {
    mockHistoryReady = true;
    mockHistoryRows = [row(1, { atMs: LIVE - 3 * DAY, rating: 'good' }), row(2, { atMs: LIVE - 2 * DAY, rating: 'hard', ivlBefore: 3, ivlAfter: 4 })];
    const { r } = render();
    expect(texts(r).some((t) => t.startsWith('History:'))).toBe(false); // not read yet
    await act(async () => {
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    });
    expect(texts(r)).toContain('History: 2 reviews · 0 lapses · last: 2 days ago (Hard)');
  });

  it('read-only: an imported card with Anki lapses — "Lapses 6" says why the History line counts only 1', async () => {
    mockState = fixture({ lapses: 6 }, LIVE); // 5 lapses from Anki + 1 in Maranki
    mockHistoryReady = true;
    mockHistoryRows = [
      row(1, { atMs: LIVE - 3 * DAY, ivlBefore: 10, ivlAfter: 20 }),
      row(2, { atMs: LIVE - 2 * DAY, rating: 'again', ivlBefore: 20, ivlAfter: 10, easeAfter: 2.3 }),
      row(3, { atMs: LIVE - DAY, ivlBefore: 1, ivlAfter: 2, easeAfter: 2.3 }),
    ];
    const { r } = render({ readOnly: true });
    expect(texts(r)).not.toContain(LAPSES_MORE_NOTE); // the history is not read yet: no count to compare
    await act(async () => {
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    });
    const all = texts(r);
    expect(all.some((t) => t.startsWith('History: 3 reviews · 1 lapse · last: '))).toBe(true);
    expect(all).toEqual(expect.arrayContaining(['6', LAPSES_MORE_NOTE]));
    // A screen reader hears the note with the number.
    expect(r.root.findAll((n) => n.props.accessibilityLabel === `Lapses: 6. ${LAPSES_MORE_NOTE}`).length).toBeGreaterThan(0);
  });

  it('read-only: when "Lapses" and the History line agree, there is no note', async () => {
    mockState = fixture({ lapses: 1 }, LIVE);
    mockHistoryReady = true;
    mockHistoryRows = [row(1, { atMs: LIVE - 2 * DAY, rating: 'again', ivlBefore: 20, ivlAfter: 10, easeAfter: 2.3 })];
    const { r } = render({ readOnly: true });
    await act(async () => {
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    });
    const all = texts(r);
    expect(all.some((t) => t.startsWith('History: 1 review · 1 lapse · last: '))).toBe(true);
    expect(all).not.toContain(LAPSES_MORE_NOTE);
    expect(all).not.toContain(LAPSES_FEWER_NOTE);
  });

  it('no history rows: a studied card shows NO History line; a never-studied card says "no reviews in Maranki yet"', async () => {
    mockHistoryReady = true;
    mockHistoryRows = [];
    const flush = () =>
      act(async () => {
        for (let i = 0; i < 5; i += 1) await Promise.resolve();
      });
    // The fixture card is a Review card (reps 4) studied before the review history existed.
    const { r } = render();
    await flush();
    expect(texts(r).some((t) => t.startsWith('History:'))).toBe(false);
    act(() => renderer!.unmount());
    renderer = null;

    mockState = fixture(lifeValues('new', LIVE), LIVE);
    const fresh = render().r;
    await flush();
    expect(texts(fresh)).toContain(CARD_SHEET_COPY.noHistory);
  });

  it('the Undo snackbar is pinned to the sheet PANEL, outside the scrolling content, and its Undo works', () => {
    const { r } = render();
    expect(r.root.findAllByType(SnackbarView)).toHaveLength(0);
    act(() => byLabel(r, 'Flag')!.props.onPress());
    const snacks = r.root.findAllByType(SnackbarView);
    expect(snacks).toHaveLength(1);
    expect(snacks[0].props.text).toBe('Unflagged');
    // At the TOP of the panel (walkthrough M5): at the bottom it covered "Delete card…".
    expect(snacks[0].props.top).toBe(SHEET_SNACK_TOP);
    expect(snacks[0].props.bottom).toBeUndefined();
    // Not inside a ScrollView: a long card (an image, many rows) cannot push it below the visible part.
    for (const scroll of r.root.findAllByType(ScrollView)) expect(scroll.findAllByType(SnackbarView)).toHaveLength(0);
    // It is on the sheet's panel (the modal view), so it moves with the sheet.
    let at: ReactTestInstance | null = snacks[0];
    let onPanel = false;
    while (at) {
      if (at.props.accessibilityViewIsModal === true) onPanel = true;
      at = at.parent;
    }
    expect(onPanel).toBe(true);
    // Its Undo takes the change back and closes the bar.
    act(() => snacks[0].props.onAction());
    expect(mockState.cards.find((c) => c.id === 'c1')?.flagged).toBe(true);
    expect(mockDismiss).toHaveBeenCalledTimes(1);
    expect(r.root.findAllByType(SnackbarView)).toHaveLength(0);
  });

  it('Reset progress… → the confirm sheet closes and the "Reset to New" Undo shows on the panel', () => {
    const { r } = render();
    act(() => byText(r, CARD_SHEET_COPY.reset).props.onPress());
    act(() => byText(r, CARD_SHEET_COPY.resetConfirm).props.onPress());
    const snack = r.root.findAllByType(SnackbarView).find((s) => s.props.text === 'Reset to New');
    expect(snack).toBeDefined();
    for (const scroll of r.root.findAllByType(ScrollView)) expect(scroll.findAllByType(SnackbarView)).toHaveLength(0);
    act(() => snack!.props.onAction());
    expect(mockState.cards.find((c) => c.id === 'c1')?.reps).toBe(4);
  });

  it('a message from BEFORE the sheet opened (a Library bulk Undo) is not shown in the sheet; a new one is', () => {
    mockSnackChannel.snack = { text: '12 cards flagged', actionLabel: 'Undo', onAction: () => undefined };
    const { r } = render();
    expect(r.root.findAllByType(SnackbarView)).toHaveLength(0);
    act(() => byLabel(r, 'Favorite')!.props.onPress());
    expect(r.root.findAllByType(SnackbarView).map((s) => s.props.text)).toEqual(['Added to Favorites']);
  });

  it('session "Card info" BEFORE the reveal: the question, status, details and History — never the answer (wave 5h)', async () => {
    mockHistoryReady = true;
    mockHistoryRows = [row(1, { atMs: LIVE - 3 * DAY, rating: 'good' })];
    const { r } = render({ readOnly: true, hideAnswer: true });
    await act(async () => {
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    });
    const all = texts(r);
    expect(all).toEqual(
      expect.arrayContaining([
        'die Reise',
        CARD_SHEET_COPY.answerHidden,
        'Review · next in 3 days',
        '🇩🇪 German › Vocabulary › B1',
        'Basic + reverse',
        'German → English',
      ]),
    );
    expect(all.some((t) => t.startsWith('History: 1 review'))).toBe(true);
    // No answer text anywhere on the sheet (the back and the Example are on the answer side).
    for (const t of all) {
      expect(t).not.toContain('the trip');
      expect(t).not.toContain('Die Reise war lang.');
    }
    // After the reveal (the session passes hideAnswer false) it shows everything, as before.
    rerender(r, { hideAnswer: false });
    expect(texts(r)).toEqual(expect.arrayContaining(['die Reise', 'the trip', 'Die Reise war lang.']));
    expect(texts(r)).not.toContain(CARD_SHEET_COPY.answerHidden);
  });

  it('outside a session the sheet is unchanged: the whole card and no "answer shows after" line', () => {
    const { r } = render();
    expect(texts(r)).toEqual(expect.arrayContaining(['die Reise', 'the trip']));
    expect(texts(r)).not.toContain(CARD_SHEET_COPY.answerHidden);
  });

  it('Articles "Card info" before the pick: the bare word (not "die Reise"), and 🔊 reads the bare word', () => {
    mockState = { ...mockState, settings: { ...mockState.settings, readAloudEnabled: true } };
    const { r } = render({ readOnly: true, hideAnswer: true, question: { text: 'Reise', lang: 'de-DE' } });
    const all = texts(r);
    expect(all).toEqual(expect.arrayContaining(['Reise', CARD_SHEET_COPY.answerHidden]));
    expect(all).not.toContain('die Reise');
    act(() => byLabel(r, CARD_SHEET_COPY.speak)!.props.onPress());
    expect(mockSpeak).toHaveBeenCalledWith('Reise', 'de-DE');
  });

  it('read-only: no snackbar on the sheet (nothing there changes anything)', () => {
    const { r } = render({ readOnly: true });
    act(() => mockShow('Card deleted'));
    expect(r.root.findAllByType(SnackbarView)).toHaveLength(0);
  });

  it('a card that is not there says so', () => {
    const { r } = render({ cardId: 'gone' });
    expect(texts(r)).toContain(CARD_SHEET_COPY.missing);
  });
});

// Wave 5g (final device pass, Evening): black line art on a transparent picture could not be
// seen on the dark paperSunk well. Every card picture now sits on the light image well.
describe('CardSheet: a card picture sits on the light image well (wave 5g)', () => {
  beforeEach(() => {
    // The "die Reise" note again, with a picture on its back (the answer line of card c1).
    const deck = makeDeckV3({ id: 'd1', name: 'German', icon: '🇩🇪' });
    const group = noteWithCards({
      deckId: 'd1',
      typeId: BUILTIN_TYPE_IDS.basicReverse,
      fields: ['die Reise', 'the trip<br><img src="trip.png">', '', ''],
      note: { id: 'n1' },
      card: (ord) => ({ id: `c${ord + 1}`, ...(ord === 0 ? lifeValues('review', LIVE) : {}) }),
    });
    mockState = stateOfV3({ decks: [deck], groups: [group] });
    mockMediaUri = (deckId, name) => `file:///media/${deckId}/${name}`;
  });

  afterEach(() => {
    mockTheme = 'light';
    mockMediaUri = () => null;
  });

  /** The background colour of every drawn picture of the sheet (the expo-image mock keeps its props). */
  function wellColors(r: ReactTestRenderer): unknown[] {
    return r.root
      .findAll((n) => typeof n.type === 'function' && (n.props.source as { uri?: string } | undefined)?.uri === 'file:///media/d1/trip.png')
      .map((n) => StyleSheet.flatten(n.props.style)?.backgroundColor);
  }

  it('Evening: the picture is drawn on c.imageWell (light), not on the dark paperSunk', () => {
    mockTheme = 'dark';
    const { r } = render();
    const colors = wellColors(r);
    expect(colors.length).toBeGreaterThan(0);
    expect(colors.every((color) => color === dark.imageWell)).toBe(true);
    expect(dark.imageWell).not.toBe(dark.paperSunk);
  });

  it('Paper: nothing changes (the well is still paperSunk)', () => {
    const { r } = render();
    const colors = wellColors(r);
    expect(colors.length).toBeGreaterThan(0);
    expect(colors.every((color) => color === light.paperSunk)).toBe(true);
  });

  // Wave 5i (release re-measure): a tap on a picture in the Library's card sheet did nothing,
  // while the same picture opened full screen in a session. Now the sheet opens the SAME viewer.
  /**
   * The full-screen viewer: the one Modal that fades (every Sheet uses animationType "none").
   * A hidden Modal draws no children, so it is found by its own props, not by "Close image".
   */
  function viewerModal(r: ReactTestRenderer): ReactTestInstance {
    const modals = r.root.findAllByType(Modal).filter((m) => m.props.animationType === 'fade');
    expect(modals).toHaveLength(1);
    return modals[0];
  }

  it('a tap on the picture opens it full screen (the study card\'s viewer); a tap closes it', () => {
    mockTheme = 'dark';
    const { r, onClose } = render();
    expect(viewerModal(r).props.visible).toBe(false);
    const picture = r.root.find(
      (n) => typeof n.type !== 'string' && n.props.accessibilityRole === 'imagebutton' && typeof n.props.onPress === 'function',
    );
    expect(picture.props.accessibilityLabel).toBe('Picture');
    expect(picture.props.accessibilityHint).toBe(OPEN_IMAGE_HINT);
    act(() => picture.props.onPress());
    const modal = viewerModal(r);
    expect(modal.props.visible).toBe(true);
    // The same look as in a session: the opaque paperSunk backdrop, the picture of THIS card on it.
    const backdrop = modal.find(
      (n) => n.type === ('View' as unknown) && n.props.accessibilityLabel === CLOSE_IMAGE_LABEL && StyleSheet.flatten(n.props.style)?.flex === 1,
    );
    expect(StyleSheet.flatten(backdrop.props.style).backgroundColor).toBe(dark.paperSunk);
    expect(
      modal.findAll((n) => typeof n.type === 'function' && (n.props.source as { uri?: string } | undefined)?.uri === 'file:///media/d1/trip.png'),
    ).not.toHaveLength(0);
    // The ✕ button closes the picture; the sheet stays open.
    const close = modal.find((n) => typeof n.type !== 'string' && n.props.label === CLOSE_IMAGE_LABEL && n.props.icon === 'close');
    act(() => close.props.onPress());
    expect(viewerModal(r).props.visible).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Android\'s Back closes the picture first (its modal is on top of the sheet), not the sheet', () => {
    const { r, onClose } = render();
    act(() =>
      r.root
        .find((n) => typeof n.type !== 'string' && n.props.accessibilityRole === 'imagebutton' && typeof n.props.onPress === 'function')
        .props.onPress(),
    );
    expect(viewerModal(r).props.visible).toBe(true);
    act(() => viewerModal(r).props.onRequestClose());
    expect(viewerModal(r).props.visible).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('read-only "Card info" of a session opens the picture too', () => {
    const { r } = render({ readOnly: true });
    act(() =>
      r.root
        .find((n) => typeof n.type !== 'string' && n.props.accessibilityRole === 'imagebutton' && typeof n.props.onPress === 'function')
        .props.onPress(),
    );
    expect(viewerModal(r).props.visible).toBe(true);
  });
});

describe('RescheduleSheet (from the CardSheet, and alone)', () => {
  it('Reschedule… → "In a week": due moves to the start of that day, the snackbar says so, Undo puts it back', () => {
    const { r } = render();
    const before = mockState.cards.find((c) => c.id === 'c1')!;
    act(() => byText(r, CARD_SHEET_COPY.reschedule).props.onPress());
    act(() => byText(r, 'In a week').props.onPress());
    const dueMs = choiceDueMs('inWeek', Date.now());
    expect(mockActions.reschedule).toHaveBeenCalledWith(['c1'], dueMs);
    const after = mockState.cards.find((c) => c.id === 'c1')!;
    expect(after.due).toBe(dueMs);
    expect([after.intervalDays, after.ease]).toEqual([before.intervalDays, before.ease]);
    expect(mockShow).toHaveBeenLastCalledWith(rescheduleSnack(dueMs, Date.now()), expect.objectContaining({ onAction: expect.any(Function) }));
    act(() => lastUndo()());
    expect(mockState.cards.find((c) => c.id === 'c1')!.due).toBe(before.due);
  });

  it('Pick a date… (inline calendar on iOS, the jest platform): the picked day, confirmed with "Reschedule"', () => {
    const { r } = render();
    act(() => byText(r, CARD_SHEET_COPY.reschedule).props.onPress());
    expect(r.root.findAllByType(DateTimePicker)).toHaveLength(0);
    act(() => byText(r, 'Pick a date…').props.onPress());
    const picker = r.root.findByType(DateTimePicker);
    // The calendar is shown ALONE: the intro and the quick rows step aside, so the calendar
    // and its Reschedule button are in the visible part of the sheet.
    const all = texts(r);
    for (const hidden of ['Tomorrow', 'In a week', 'Pick a date…']) expect(all).not.toContain(hidden);
    expect(all.some((t) => t.endsWith('The difficulty stays the same.'))).toBe(false);
    expect(picker.props.mode).toBe('date');
    expect(picker.props.minimumDate.getTime()).toBe(addLocalDays(Date.now(), 1));
    const day = addLocalDays(Date.now(), 10);
    act(() => picker.props.onValueChange({ nativeEvent: { timestamp: day, utcOffset: 0 } }, new Date(day + 15 * HOUR)));
    const confirm = r.root.findAll(
      (n) => typeof n.props.onPress === 'function' && String(n.props.accessibilityLabel ?? '').startsWith('Reschedule to '),
    )[0];
    act(() => confirm.props.onPress());
    expect(mockActions.reschedule).toHaveBeenCalledWith(['c1'], day);
  });

  it('iOS calendar: a value it cannot use (1970, today) is ignored — the last good day stays and is the one moved to', () => {
    const { r } = render();
    act(() => byText(r, CARD_SHEET_COPY.reschedule).props.onPress());
    act(() => byText(r, 'Pick a date…').props.onPress());
    const change = (date: Date) =>
      act(() =>
        r.root
          .findByType(DateTimePicker)
          .props.onValueChange({ type: 'set', nativeEvent: { timestamp: date.getTime(), utcOffset: 0 } }, date),
      );
    const day = addLocalDays(Date.now(), 5);
    change(new Date(day + 12 * HOUR));
    change(new Date(0));
    change(new Date(Number.NaN));
    change(new Date(Date.now()));
    const confirm = r.root.findAll(
      (n) => typeof n.props.onPress === 'function' && String(n.props.accessibilityLabel ?? '').startsWith('Reschedule to '),
    )[0];
    act(() => confirm.props.onPress());
    expect(mockActions.reschedule).toHaveBeenCalledTimes(1);
    expect(mockActions.reschedule).toHaveBeenCalledWith(['c1'], day);
  });

  it('Pick a date… then Cancel: the calendar closes and the rows come back; nothing changes', () => {
    const { r } = render();
    act(() => byText(r, CARD_SHEET_COPY.reschedule).props.onPress());
    act(() => byText(r, 'Pick a date…').props.onPress());
    expect(r.root.findAllByType(DateTimePicker)).toHaveLength(1);
    act(() => byText(r, 'Cancel').props.onPress());
    expect(r.root.findAllByType(DateTimePicker)).toHaveLength(0);
    expect(texts(r)).toEqual(expect.arrayContaining(['Tomorrow', 'In 3 days', 'In a week', 'In a month', 'Pick a date…']));
    expect(mockActions.reschedule).not.toHaveBeenCalled();
  });

  it('with onDone, the caller gets the edit id and the due day, and shows the snackbar itself', () => {
    const onDone = jest.fn<(r: { editId: string; dueMs: number }) => void>();
    const onClose = jest.fn<() => void>();
    act(() => {
      renderer = TestRenderer.create(React.createElement(RescheduleSheet, { cardIds: ['c1'], open: true, onClose, onDone }));
    });
    act(() => byText(renderer!, 'Tomorrow').props.onPress());
    const dueMs = choiceDueMs('tomorrow', Date.now());
    expect(onDone).toHaveBeenCalledWith({ editId: expect.any(String), dueMs });
    expect(onClose).toHaveBeenCalled();
    expect(mockShow).not.toHaveBeenCalled();
    const { editId } = onDone.mock.calls[0][0];
    expect(mockState.manualLog.some((e) => e.id === editId)).toBe(true);
  });

  it('a card without a schedule: "Not studied yet — nothing to reschedule", no choices', () => {
    mockState = fixture(lifeValues('new', LIVE), LIVE);
    act(() => {
      renderer = TestRenderer.create(React.createElement(RescheduleSheet, { cardIds: ['c1'], open: true, onClose: () => undefined }));
    });
    const all = texts(renderer!);
    expect(all).toContain(NOTHING_TO_RESCHEDULE);
    expect(all).not.toContain('Tomorrow');
    expect(mockActions.reschedule).not.toHaveBeenCalled();
  });
});

describe('RescheduleSheet on Android (the Material dialog)', () => {
  let restoreOs: (() => void) | null = null;

  beforeEach(() => {
    const replaced = jest.replaceProperty(Platform, 'OS', 'android');
    restoreOs = () => replaced.restore();
  });

  afterEach(() => {
    if (renderer) act(() => renderer!.unmount());
    renderer = null;
    restoreOs?.();
    restoreOs = null;
  });

  /** Open the sheet and tap "Pick a date…"; returns the renderer and how to find and answer the dialog. */
  function openDialog() {
    const onClose = jest.fn<() => void>();
    act(() => {
      renderer = TestRenderer.create(React.createElement(RescheduleSheet, { cardIds: ['c1'], open: true, onClose }));
    });
    const r = renderer!;
    act(() => byText(r, 'Pick a date…').props.onPress());
    const dialogs = () => r.root.findAllByType(DateTimePicker);
    /** The dialog's OK with this value (what the @expo/ui wrapper passes to onValueChange). */
    const ok = (date: Date) =>
      act(() =>
        dialogs()[0].props.onValueChange({ type: 'set', nativeEvent: { timestamp: date.getTime(), utcOffset: 0 } }, date),
      );
    return { r, onClose, dialogs, ok };
  }

  /** Material's value for a local day: UTC midnight of that calendar day. */
  const materialDay = (dayMs: number) => {
    const d = new Date(dayMs);
    return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  };

  it('an empty or wrong typed date (it arrives as 1 January 1970) changes nothing, and the dialog stays open', () => {
    const { r, onClose, dialogs, ok } = openDialog();
    expect(dialogs()).toHaveLength(1);
    expect(dialogs()[0].props.presentation).toBe('dialog');
    expect(texts(r)).toContain('Tomorrow'); // the rows stay under the dialog
    const before = mockState.cards.find((c) => c.id === 'c1')!.due;

    ok(new Date(0)); // `new Date(null)`: Material had no selected day
    ok(new Date(Number.NaN));
    ok(materialDay(Date.now())); // a typed day before tomorrow: today …
    ok(new Date(Date.UTC(2020, 0, 1))); // … or 01/01/2020

    expect(mockActions.reschedule).not.toHaveBeenCalled();
    expect(mockState.cards.find((c) => c.id === 'c1')!.due).toBe(before);
    expect(mockShow).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    // Still open: Material shows its error under the field, and the learner can fix the date or Cancel.
    expect(dialogs()).toHaveLength(1);
  });

  it('then a real day: due moves to the start of that LOCAL day, the dialog and the sheet close, Undo is offered', () => {
    const { onClose, dialogs, ok } = openDialog();
    ok(new Date(0));
    const day = addLocalDays(Date.now(), 10);
    ok(materialDay(day));
    expect(mockActions.reschedule).toHaveBeenCalledTimes(1);
    expect(mockActions.reschedule).toHaveBeenCalledWith(['c1'], day);
    expect(mockState.cards.find((c) => c.id === 'c1')!.due).toBe(day);
    expect(onClose).toHaveBeenCalled();
    expect(dialogs()).toHaveLength(0);
    expect(mockShow).toHaveBeenLastCalledWith(
      rescheduleSnack(day, Date.now()),
      expect.objectContaining({ onAction: expect.any(Function) }),
    );
  });

  it('Cancel (the dialog is dismissed): the dialog closes, the rows stay, nothing changes', () => {
    const { r, onClose, dialogs } = openDialog();
    act(() => dialogs()[0].props.onDismiss());
    expect(dialogs()).toHaveLength(0);
    expect(texts(r)).toContain('Tomorrow');
    expect(onClose).not.toHaveBeenCalled();
    expect(mockActions.reschedule).not.toHaveBeenCalled();
  });
});

/* ================================================================ part 3: wave 5b polish */

describe('the Undo bar on the CardSheet (walkthrough M5)', () => {
  it('sits at the top of the panel: the bar\'s box starts at the top, so "Delete card…" at the bottom is never under it', () => {
    const { r } = render();
    act(() => byText(r, CARD_SHEET_COPY.reset).props.onPress());
    act(() => byText(r, CARD_SHEET_COPY.resetConfirm).props.onPress());
    const snack = r.root.findAllByType(SnackbarView).find((v) => v.props.text === 'Reset to New')!;
    expect(snack.props.top).toBe(SHEET_SNACK_TOP);
    // The host view of the bar is placed by `top` only (no `bottom` inset that could reach the last rows).
    const box = snack.findAll((n) => typeof n.type === 'string' && n.props.accessibilityLiveRegion === 'polite')[0];
    const style = Object.assign({}, ...[box.props.style].flat(5).filter(Boolean)) as Record<string, unknown>;
    expect(style.top).toBe(SHEET_SNACK_TOP);
    expect(style.bottom).toBeUndefined();
    // The Delete row is still there, below, and is not inside the bar.
    expect(texts(r)).toContain(CARD_SHEET_COPY.delete);
    expect(snack.findAll((n) => (n.type as unknown) === 'Text' && n.props.children === CARD_SHEET_COPY.delete)).toHaveLength(0);
  });

  it('the bar is a polite live region and its Undo is a labelled button', () => {
    const { r } = render();
    act(() => byLabel(r, 'Favorite')!.props.onPress());
    const snack = r.root.findAllByType(SnackbarView)[0];
    const button = snack.findAll((n) => typeof n.type !== 'string' && n.props.accessibilityRole === 'button')[0];
    expect(button.props.accessibilityLabel).toBe('Undo');
    expect(snack.findAll((n) => n.props.accessibilityLiveRegion === 'polite').length).toBeGreaterThan(0);
  });

  it('a screen\'s bar (no `top`) still sits at its `bottom`, as before', () => {
    act(() => {
      renderer = TestRenderer.create(React.createElement(SnackbarView, { text: 'Deck saved', bottom: 40 }));
    });
    const box = renderer!.root.findAll((n) => typeof n.type === 'string' && n.props.accessibilityLiveRegion === 'polite')[0];
    const style = Object.assign({}, ...[box.props.style].flat(5).filter(Boolean)) as Record<string, unknown>;
    expect(style.bottom).toBe(40);
    expect(style.top).toBeUndefined();
  });
});

describe('the snackbar channel: how long an Undo stays (walkthrough M5, the REAL SnackbarProvider)', () => {
  const real = jest.requireActual<typeof import('../../store/SnackbarContext')>('../../store/SnackbarContext');
  type Channel = ReturnType<typeof real.useSnackbar>;
  let channel: Channel | null = null;
  let screenReaderChanged: ((on: boolean) => void) | null = null;
  const restores: (() => void)[] = [];

  /** Reads the real channel on every render. */
  function Probe() {
    channel = real.useSnackbar();
    return null;
  }

  /** Mount the real provider; the OS says the screen reader is `on`. */
  async function mount(on: boolean, tree: React.ReactElement = React.createElement(real.SnackbarProvider, null, React.createElement(Probe))) {
    const read = jest.spyOn(AccessibilityInfo, 'isScreenReaderEnabled').mockImplementation(() => Promise.resolve(on));
    const listen = jest.spyOn(AccessibilityInfo, 'addEventListener').mockImplementation(((event: string, handler: (on: boolean) => void) => {
      if (event === 'screenReaderChanged') screenReaderChanged = handler;
      return { remove: () => undefined };
    }) as unknown as typeof AccessibilityInfo.addEventListener);
    restores.push(() => read.mockRestore(), () => listen.mockRestore());
    act(() => {
      renderer = TestRenderer.create(tree);
    });
    // The OS answer arrives later (a promise): let it land.
    await act(async () => {
      await Promise.resolve();
    });
  }

  /** The message on screen after `ms` more milliseconds. */
  function after(ms: number): string | null {
    act(() => {
      jest.advanceTimersByTime(ms);
    });
    return channel?.snack?.text ?? null;
  }

  beforeEach(() => {
    jest.useFakeTimers();
    channel = null;
    screenReaderChanged = null;
  });

  afterEach(() => {
    if (renderer) act(() => renderer!.unmount());
    renderer = null;
    jest.useRealTimers();
    while (restores.length > 0) restores.pop()!();
  });

  it('snackDurationMs: an Undo stays ≥ 5 s, ≥ 10 s with a screen reader; a plain message keeps 2.8 s', () => {
    expect(real.snackDurationMs({ hasAction: false, screenReader: false })).toBe(2800);
    expect(real.snackDurationMs({ hasAction: true, screenReader: false })).toBeGreaterThanOrEqual(5000);
    expect(real.snackDurationMs({ hasAction: true, screenReader: true })).toBeGreaterThanOrEqual(10000);
    expect(real.snackDurationMs({ hasAction: false, screenReader: true })).toBeGreaterThan(2800);
  });

  it('an Undo bar is still there after 5 s, and gone after its time', async () => {
    await mount(false);
    act(() => channel!.show('Unflagged', { onAction: () => undefined }));
    expect(after(5000)).toBe('Unflagged');
    expect(after(real.SNACK_ACTION_MS - 5000)).toBeNull();
  });

  it('a plain message closes after 2.8 s, as before', async () => {
    await mount(false);
    act(() => channel!.show('Deck saved'));
    expect(after(2700)).toBe('Deck saved');
    expect(after(200)).toBeNull();
  });

  it('with a screen reader on, an Undo bar is still there after 10 s', async () => {
    await mount(true);
    act(() => channel!.show('Marked as known', { onAction: () => undefined }));
    expect(after(10000)).toBe('Marked as known');
    expect(after(real.SNACK_ACTION_SCREEN_READER_MS - 10000)).toBeNull();
  });

  it('a screen reader turned on later counts from the next message', async () => {
    await mount(false);
    act(() => screenReaderChanged!(true));
    act(() => channel!.show('Reset to New', { onAction: () => undefined }));
    expect(after(10000)).toBe('Reset to New');
  });

  it('a new message starts its own time; Undo and dismiss() close the bar at once', async () => {
    await mount(false);
    act(() => channel!.show('first', { onAction: () => undefined }));
    expect(after(4000)).toBe('first');
    act(() => channel!.show('second', { onAction: () => undefined }));
    expect(after(4000)).toBe('second'); // the first message's timer did not close the second
    act(() => channel!.dismiss());
    expect(channel!.snack).toBeNull();
  });

  it('useSnackDuration (for a screen that draws its own snackbar): the same times, following the screen reader', async () => {
    const seen: ((hasAction: boolean) => number)[] = [];
    /** A screen with its own snackbar, outside any provider (like the study session). */
    function OwnSnackbar() {
      seen.push(real.useSnackDuration());
      return null;
    }
    await mount(false, React.createElement(OwnSnackbar));
    const durationFor = seen[seen.length - 1];
    expect(durationFor(true)).toBe(real.SNACK_ACTION_MS);
    expect(durationFor(false)).toBe(real.SNACK_PLAIN_MS);
    act(() => screenReaderChanged!(true));
    expect(durationFor(true)).toBe(real.SNACK_ACTION_SCREEN_READER_MS);
    expect(durationFor(false)).toBe(real.SNACK_PLAIN_SCREEN_READER_MS);
    // The same function on every render (safe in an effect's dependency list).
    act(() => renderer!.update(React.createElement(OwnSnackbar)));
    expect(new Set(seen).size).toBe(1);
  });

  it('useSnackDuration reads the screen reader answer the OS gives at the start', async () => {
    const seen: ((hasAction: boolean) => number)[] = [];
    function OwnSnackbar() {
      seen.push(real.useSnackDuration());
      return null;
    }
    await mount(true, React.createElement(OwnSnackbar));
    expect(seen[seen.length - 1](true)).toBeGreaterThanOrEqual(10_000);
  });
});

describe('sheets and the keyboard (walkthrough M3)', () => {
  it('a sheet\'s body passes the first tap to its buttons while the keyboard is open', () => {
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(
          Sheet,
          // `children` comes as the third argument (the lint rule), so the props alone are cast.
          { open: true, onClose: () => undefined, title: 'Save as list' } as React.ComponentProps<typeof Sheet>,
          React.createElement(Text, null, 'B1 verbs'),
        ),
      );
    });
    const scrolls = renderer!.root.findAllByType(ScrollView);
    expect(scrolls).toHaveLength(1);
    expect(scrolls[0].props.keyboardShouldPersistTaps).toBe('handled');
  });

  it('every scrolling part of the CardSheet (and the smaller sheets on it) does the same', () => {
    const { r } = render();
    act(() => byText(r, CARD_SHEET_COPY.reset).props.onPress());
    const scrolls = r.root.findAllByType(ScrollView);
    expect(scrolls.length).toBeGreaterThan(1);
    for (const scroll of scrolls) expect(scroll.props.keyboardShouldPersistTaps).toBe('handled');
  });

  it('the card editor, deck editor and import screens: every ScrollView in their source keeps taps', () => {
    // These screens need the whole router and store to render, so the rule is checked in their source:
    // every <ScrollView …> opening tag says keyboardShouldPersistTaps="handled".
    const SRC = path.join(__dirname, '..', '..');
    for (const file of ['app/card-editor.tsx', 'app/deck-editor.tsx', 'app/import.tsx', 'components/ui/Sheet.tsx']) {
      const source = fs.readFileSync(path.join(SRC, file), 'utf8');
      // JSX opening tags only: not the type argument of `useRef<ScrollView>(null)`.
      const tags = source.match(/<ScrollView(\s[^>]*)?>(?!\()/g) ?? [];
      expect([file, tags.length > 0]).toEqual([file, true]);
      for (const tag of tags) expect([file, tag.includes('keyboardShouldPersistTaps="handled"')]).toEqual([file, true]);
    }
  });
});

describe('field labels: whole, and never an internal name (walkthrough L3 / R6)', () => {
  /** An imported card type with long and internal field names (no labels of its own). */
  const imported: NoteType = {
    id: 'nt-imported',
    name: 'German Vocabulary (bidirectional)',
    kind: 'standard',
    fields: [
      { name: 'Word', role: 'term', facet: 'off' },
      { name: 'Pronunciation', role: 'pronunciation', facet: 'off' },
      { name: 'Example translation', role: 'exampleMeaning', facet: 'off' },
      { name: 'MarankiExample', role: 'example', facet: 'off' },
      { name: 'VerbForms', role: 'detail', facet: 'auto' },
    ],
    templates: [{ ord: 0, name: 'DE-EN', prompt: [0], answer: [1, 2, 3, 4] }],
    sortField: 0,
    source: { ankiMid: '42' },
    createdAt: 0,
    updatedAt: 0,
  };
  const note = {
    id: 'n-imported',
    typeId: imported.id,
    fields: ['die Stunde', '/ˈʃtʊndə/', 'We meet in an hour.', 'Wir treffen uns in einer Stunde.', 'Stunden'],
    tags: [],
    section: '',
    guid: 'g-imported',
    order: 0,
    source: { kind: 'apkg' as const },
    createdAt: 0,
    updatedAt: 0,
  };

  /** The width of a host Text's style, or undefined. */
  function widthOf(n: ReactTestInstance): number | undefined {
    return [n.props.style].flat(5).reduce<number | undefined>((w, st) => (st && (st as { width?: number }).width !== undefined ? (st as { width: number }).width : w), undefined);
  }

  /**
   * The label Text of each row of a side-by-side FieldRows: the column width
   * at the test's font scale (the jest setup says 2), the label font cap.
   */
  function labelTexts(r: ReactTestRenderer): ReactTestInstance[] {
    const width = labelColumnWidth(Dimensions.get('window').fontScale);
    return r.root.findAll((n) => (n.type as unknown) === 'Text' && widthOf(n) === width);
  }

  /** Render with the system text size `fontScale` (Dimensions.set, as the OS does), then put the old size back. */
  function withFontScale(fontScale: number, run: () => void) {
    const before = { window: Dimensions.get('window'), screen: Dimensions.get('screen') };
    Dimensions.set({ window: { ...before.window, fontScale }, screen: { ...before.screen, fontScale } });
    try {
      run();
    } finally {
      if (renderer) act(() => renderer!.unmount());
      renderer = null;
      Dimensions.set(before);
    }
  }

  it('the rows say "Pronunciation", "Example translation", "Example", "Verb Forms": whole, and allowed to wrap', () => {
    const face = renderFace(note, imported, 0);
    act(() => {
      renderer = TestRenderer.create(React.createElement(FieldRows, { blocks: face.answer }));
    });
    const labels = labelTexts(renderer!);
    expect(labels.map((t) => t.props.children)).toEqual(['Pronunciation', 'Example translation', 'Example', 'Verb Forms']);
    // Never cut to one line ("PRONUNCIATI…"): no numberOfLines on a label.
    for (const label of labels) expect(label.props.numberOfLines).toBeUndefined();
    // A screen reader hears the same whole label.
    const rows = renderer!.root.findAll((n) => typeof n.type === 'string' && n.props.accessible === true);
    expect(rows.map((n) => n.props.accessibilityLabel)).toContain('Example: Wir treffen uns in einer Stunde.');
    expect(rows.some((n) => String(n.props.accessibilityLabel).includes('MarankiExample'))).toBe(false);
  });

  it('the label column is wide enough for "PRONUNCIATION" on one line at the normal text size', () => {
    // About 100 pt in the 11 pt label font with its letter spacing (Hanken Grotesk 700 metrics).
    expect(LABEL_COLUMN_WIDTH).toBeGreaterThanOrEqual(104);
  });

  it('labelColumnWidth: the column grows with the system text size, up to the label font cap (review of L3)', () => {
    expect(labelColumnWidth(1)).toBe(LABEL_COLUMN_WIDTH);
    expect(labelColumnWidth(1.3)).toBe(141);
    expect(labelColumnWidth(LABEL_FONT_CAP)).toBe(162);
    expect(labelColumnWidth(2)).toBe(162);
    expect(labelColumnWidth(3.1)).toBe(162);
    // Smaller text, or no answer from the OS: the normal column.
    expect(labelColumnWidth(0.85)).toBe(LABEL_COLUMN_WIDTH);
    expect(labelColumnWidth(Number.NaN)).toBe(LABEL_COLUMN_WIDTH);
  });

  it('"PRONUNCIATION" stays on one line at EVERY text size: never "PRONUNCIA / TION" (review of L3)', () => {
    // Measured with Hanken Grotesk 700 at 11 pt, letter spacing 0.99 pt: 99.6 pt at font scale 1.
    const PRONUNCIATION_PT = 99.6;
    for (const scale of [0.85, 1, 1.15, 1.3, 1.5, 1.75, 2, 3.1]) {
      // The label text grows with the scale, but not past its maxFontSizeMultiplier (LABEL_FONT_CAP).
      const textWidth = PRONUNCIATION_PT * Math.min(scale, LABEL_FONT_CAP);
      expect([scale, textWidth <= labelColumnWidth(scale)]).toEqual([scale, true]);
    }
  });

  it('rendered at a larger text size: a wider column, and the label text stops growing where the column does', () => {
    const face = renderFace(note, imported, 0);
    for (const [scale, width] of [
      [1, 108],
      [1.3, 141],
      [2, 162],
    ] as const) {
      withFontScale(scale, () => {
        act(() => {
          renderer = TestRenderer.create(React.createElement(FieldRows, { blocks: face.answer }));
        });
        const label = renderer!.root.findAll((n) => (n.type as unknown) === 'Text' && n.props.children === 'Pronunciation')[0];
        expect([scale, widthOf(label)]).toEqual([scale, width]);
        expect(label.props.maxFontSizeMultiplier).toBe(LABEL_FONT_CAP);
      });
    }
    // The stacked rows (the study card) have no column: their label keeps growing, as before.
    withFontScale(2, () => {
      act(() => {
        renderer = TestRenderer.create(React.createElement(FieldRows, { blocks: face.answer, variant: 'stacked' }));
      });
      const label = renderer!.root.findAll((n) => (n.type as unknown) === 'Text' && n.props.children === 'Pronunciation')[0];
      expect(widthOf(label)).toBeUndefined();
      expect(label.props.maxFontSizeMultiplier).toBeUndefined();
    });
  });

  // Wave 5c (review of L3): the read-only "Card info" rows still used a
  // one-line 96 pt Overline. "REPETITIONS" (about 84 pt at the normal text
  // size) was cut to "REPETITI…" from a text size of about 1.15, and the
  // info values did not start where the field values above them start.
  it('Card info rows (the session’s read-only CardSheet): the field rows’ label column, and the label wraps', () => {
    for (const [scale, width] of [
      [1, 108],
      [1.3, 141],
      [2, 162],
    ] as const) {
      withFontScale(scale, () => {
        act(() => {
          renderer = TestRenderer.create(React.createElement(CardSheet, { cardId: 'c1', open: true, onClose: () => undefined, readOnly: true }));
        });
        const label = (text: string) => renderer!.root.findAll((n) => (n.type as unknown) === 'Text' && n.props.children === text)[0];
        for (const name of ['Card type', 'Direction', 'Repetitions', 'Lapses', 'Ease']) {
          const info = label(name);
          expect([scale, name, widthOf(info)]).toEqual([scale, name, width]);
          // Never cut to one line; the text grows with the system text size up to the column's cap.
          expect(info.props.numberOfLines).toBeUndefined();
          expect(info.props.maxFontSizeMultiplier).toBe(LABEL_FONT_CAP);
        }
        // The field row above the info rows ("Example") has the same column: the values of both start at one place.
        expect(widthOf(label('Example'))).toBe(width);
      });
    }
  });

  it('a placeholder dash field is not a row (walkthrough L4)', () => {
    const dashed = { ...note, id: 'n-dashed', fields: ['der Schinken', '–', '-', 'Ich möchte Schinken.', '—'] };
    act(() => {
      renderer = TestRenderer.create(React.createElement(FieldRows, { blocks: renderFace(dashed, imported, 0).answer }));
    });
    expect(labelTexts(renderer!).map((t) => t.props.children)).toEqual(['Example']);
  });
});

describe('the card type list keeps its "…" with the word before it (walkthrough L10)', () => {
  const LONG = '2 directions · Word, Grammar, Verb Forms, Examples, Translation, …';

  it('keepEllipsisWithWord: the space before a final "…" becomes a no-break space; nothing else changes', () => {
    expect(keepEllipsisWithWord(LONG)).toBe('2 directions · Word, Grammar, Verb Forms, Examples, Translation,\u00a0…');
    expect(keepEllipsisWithWord('1 direction · Front, Back, Example, Notes')).toBe('1 direction · Front, Back, Example, Notes');
    expect(keepEllipsisWithWord('Cloze · Text, Extra')).toBe('Cloze · Text, Extra');
    expect(keepEllipsisWithWord('A …  ')).toBe('A …  '); // not a FINAL "…"
  });

  it('the open list draws the glued text', () => {
    const options = [
      { id: 'nt-vocab', name: 'German Vocabulary (bidirectional)', sub: LONG },
      { id: 'nt-basic', name: 'Basic', sub: '1 direction · Front, Back, Example, Notes' },
    ];
    act(() => {
      renderer = TestRenderer.create(React.createElement(CardTypePicker, { options, value: 'nt-vocab', onChange: () => undefined }));
    });
    act(() => byLabel(renderer!, 'Card type: German Vocabulary (bidirectional). Change')!.props.onPress());
    const all = texts(renderer!);
    expect(all).toContain('2 directions · Word, Grammar, Verb Forms, Examples, Translation,\u00a0…');
    expect(all.some((t) => / …$/.test(t))).toBe(false);
  });
});

describe('the deck editor shows the card type new cards really start with (review of walkthrough L10)', () => {
  /** An imported card type of its own (two directions), like "German Vocabulary" of German_Vocabulary.apkg. */
  const vocab: NoteType = {
    id: 'nt-vocab',
    name: 'German Vocabulary (bidirectional)',
    kind: 'standard',
    fields: [
      { name: 'Word', role: 'term', facet: 'off' },
      { name: 'Translation', role: 'meaning', facet: 'off' },
    ],
    templates: [
      { ord: 0, name: 'DE-EN', prompt: [0], answer: [1] },
      { ord: 1, name: 'EN-DE', prompt: [1], answer: [0] },
    ],
    sortField: 0,
    source: { ankiMid: '7' },
    createdAt: 0,
    updatedAt: 0,
  };

  /** An imported deck: the import makes it with defaultTypeId 'nt-basic' (makeDeck), like every deck. */
  function importedState(): DataStateV3 {
    const deck = makeDeckV3({ id: 'd-ger', name: 'German Vocabulary', source: 'apkg' });
    expect(deck.defaultTypeId).toBe(BUILTIN_TYPE_IDS.basic);
    const groups = [
      ...['die Stunde', 'der Hund', 'das Haus'].map((word, i) =>
        noteWithCards({ deckId: 'd-ger', typeId: vocab.id, fields: [word, `meaning ${i}`], note: { id: `nv-${i}` } }, [vocab]),
      ),
      noteWithCards({ deckId: 'd-ger', fields: ['own card', 'typed in the app', '', ''], note: { id: 'nb-0' } }),
    ];
    return stateOfV3({ decks: [deck], groups, types: [vocab] });
  }

  /** The card type the card editor starts a new card of `deckId` with (its rule: roles.newCardTypeId). */
  function cardEditorType(deckId: string): string | null {
    const { decks, notes, cards, noteTypes } = mockState;
    return newCardTypeId(decks.find((d) => d.id === deckId), notes, noteIdsInDeck(cards, deckId), noteTypes);
  }

  async function openEditor(deckId: string): Promise<ReactTestRenderer> {
    mockRouteParams = { deckId };
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(DeckEditorScreen));
    });
    return renderer!;
  }

  /** The card type choices of the list (composite radio buttons). */
  function radios(r: ReactTestRenderer): ReactTestInstance[] {
    return r.root.findAll((n) => typeof n.type !== 'string' && n.props.accessibilityRole === 'radio' && typeof n.props.onPress === 'function');
  }
  const nameOf = (radio: ReactTestInstance) => String(radio.props.accessibilityLabel).split('. ')[0];
  const checked = (r: ReactTestRenderer) => radios(r).filter((x) => x.props.accessibilityState?.checked === true).map(nameOf);

  afterEach(() => {
    mockRouteParams = {};
  });

  it('an imported deck shows its own card type as chosen (what the card editor starts with); Basic is a choice, not the value', async () => {
    mockState = importedState();
    expect(cardEditorType('d-ger')).toBe(vocab.id);
    const r = await openEditor('d-ger');
    expect(checked(r)).toEqual(['German Vocabulary (bidirectional)']);
    // Wave 5c: Basic stays selectable (a saved Basic now takes effect, see the next test).
    expect(radios(r).map(nameOf)).toEqual(['German Vocabulary (bidirectional)', 'Basic', 'Basic + reverse']);
    expect(radios(r)[0].props.accessibilityLabel).toBe('German Vocabulary (bidirectional). 3 items in this deck');
    // No SegCtrl "Basic" option: the deck's own type needs the list. (A SegCtrl option is a
    // radio labelled just "Basic"; a list row is "Basic. {n} items…" — wave 5e F1-4.)
    expect(radios(r).map((x) => x.props.accessibilityLabel)).not.toContain('Basic');
    expect(texts(r)).toContain('For cards you add from now on. To add one card of another type, choose it in the card editor.');
  });

  it('wave 5c: Basic, saved in an imported deck, is what new cards start with; reopened, the editor shows Basic', async () => {
    mockState = importedState();
    let r = await openEditor('d-ger');
    act(() => radios(r).find((x) => nameOf(x) === 'Basic')!.props.onPress());
    act(() => byText(r, 'Save').props.onPress());
    // Saved as the learner's choice: not the Basic every deck gets when it is made.
    expect(mockActions.updateDeck).toHaveBeenCalledWith('d-ger', {
      defaultTypeId: BUILTIN_TYPE_IDS.basic,
      defaultTypeChosen: true,
    });
    expect(mockState.decks.find((d) => d.id === 'd-ger')).toMatchObject({ defaultTypeId: BUILTIN_TYPE_IDS.basic, defaultTypeChosen: true });
    // The card editor's rule (roles.newCardTypeId) now starts a new card of this deck as Basic.
    expect(cardEditorType('d-ger')).toBe(BUILTIN_TYPE_IDS.basic);
    act(() => r.unmount());

    r = await openEditor('d-ger');
    expect(checked(r)).toEqual(['Basic']);
    expect(radios(r).map(nameOf)).toEqual(['German Vocabulary (bidirectional)', 'Basic', 'Basic + reverse']);
  });

  it('Basic + reverse, saved, is what new cards start with; reopened, the deck’s own type can be chosen back', async () => {
    mockState = importedState();
    let r = await openEditor('d-ger');
    act(() => radios(r).find((x) => nameOf(x) === 'Basic + reverse')!.props.onPress());
    act(() => byText(r, 'Save').props.onPress());
    expect(mockActions.updateDeck).toHaveBeenCalledWith('d-ger', {
      defaultTypeId: BUILTIN_TYPE_IDS.basicReverse,
      defaultTypeChosen: true,
    });
    expect(cardEditorType('d-ger')).toBe(BUILTIN_TYPE_IDS.basicReverse);
    act(() => r.unmount());

    r = await openEditor('d-ger');
    expect(checked(r)).toEqual(['Basic + reverse']);
    act(() => radios(r).find((x) => nameOf(x) === 'German Vocabulary (bidirectional)')!.props.onPress());
    act(() => byText(r, 'Save').props.onPress());
    expect(cardEditorType('d-ger')).toBe(vocab.id);
    act(() => r.unmount());

    r = await openEditor('d-ger');
    expect(checked(r)).toEqual(['German Vocabulary (bidirectional)']);
  });

  it('opening and saving without a change keeps the deck as it is (no card type is written)', async () => {
    mockState = importedState();
    const r = await openEditor('d-ger');
    act(() => byText(r, 'Save').props.onPress());
    expect(mockActions.updateDeck).not.toHaveBeenCalled();
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  it('a deck made in the app keeps the SegCtrl "Basic" / "Basic + reverse", with its setting selected', async () => {
    mockState = stateOfV3({
      decks: [makeDeckV3({ id: 'd-own', name: 'Capitals', defaultTypeId: BUILTIN_TYPE_IDS.basicReverse })],
      groups: [noteWithCards({ deckId: 'd-own', typeId: BUILTIN_TYPE_IDS.basicReverse, note: { id: 'nr-0' } })],
    });
    const r = await openEditor('d-own');
    // No list: the only radio buttons are the SegCtrl's two options (wave 5e F1-4: a SegCtrl
    // option is a "radio" with `checked`; it was a "tab" with `selected`).
    const tabs = radios(r);
    expect(tabs.map((t) => t.props.accessibilityLabel)).toEqual(['Basic', 'Basic + reverse']);
    expect(tabs.filter((t) => t.props.accessibilityState?.checked).map((t) => t.props.accessibilityLabel)).toEqual(['Basic + reverse']);
    expect(cardEditorType('d-own')).toBe(BUILTIN_TYPE_IDS.basicReverse);
  });
});

describe('the card editor: its "Added · Undo" bar is never over "Save & add another" (wave 5c)', () => {
  // WHY: "Save & add another" shows "Added · Undo" for 6 s, and that Undo
  // deletes the card just added. At the bottom of the screen the Undo could
  // sit over "Save & add another" (the Save row scrolled to the bottom edge):
  // a quick tap for the next card hit Undo, deleted the card just added, and
  // the card being typed was not saved.
  afterEach(() => {
    mockRouteParams = {};
  });

  function openCardEditor(): ReactTestRenderer {
    mockState = fixture({}, LIVE);
    mockRouteParams = { deckId: 'd1' };
    act(() => {
      renderer = TestRenderer.create(React.createElement(CardEditorScreen));
    });
    return renderer!;
  }

  /** Type into the first field boxes of the form, in order (the tag box comes after them). */
  function typeFields(r: ReactTestRenderer, values: string[]) {
    const boxes = r.root.findAll((n) => typeof n.type !== 'string' && typeof n.props.onChangeText === 'function');
    values.forEach((value, i) => act(() => boxes[i].props.onChangeText(value)));
  }

  it('"Save & add another": the bar sits at the TOP of the form, the form scrolls back to the top, and Undo works', () => {
    const r = openCardEditor();
    // Destructured: the face guard (face.test.ts) forbids a direct property read of the notes here.
    const noteCount = () => {
      const { notes } = mockState;
      return notes.length;
    };
    const before = noteCount();
    typeFields(r, ['der Hafen', 'the harbour']);
    act(() => byText(r, 'Save & add another').props.onPress());
    expect(mockActions.addNote).toHaveBeenCalledTimes(1);
    expect(noteCount()).toBe(before + 1);
    expect(mockShow).toHaveBeenLastCalledWith('Added', expect.objectContaining({ onAction: expect.any(Function) }));
    // The bar: at the top of the form (a `top`, no `bottom`), outside the scrolling content.
    const bars = r.root.findAllByType(SnackbarView);
    expect(bars).toHaveLength(1);
    expect(bars[0].props.text).toBe('Added');
    expect(typeof bars[0].props.top).toBe('number');
    expect(bars[0].props.bottom).toBeUndefined();
    const scroll = r.root.findByType(ScrollView);
    expect(scroll.findAllByType(SnackbarView)).toHaveLength(0);
    // The bottom host is not drawn on the form: nothing sits at the bottom edge.
    expect(r.root.findAllByType(SnackbarHost)).toHaveLength(0);
    // Back to the top: the first field (where the cursor goes) is below the bar, never under it.
    expect((scroll.instance as { scrollTo: jest.Mock }).scrollTo).toHaveBeenCalledWith({ y: 0, animated: true });
    expect(texts(r)).toContain('1 added');
    // Its Undo takes the card back and closes the bar.
    act(() => bars[0].props.onAction());
    expect(mockActions.deleteNotes).toHaveBeenCalledTimes(1);
    expect(noteCount()).toBe(before);
    expect(r.root.findAllByType(SnackbarView)).toHaveLength(0);
    expect(texts(r)).not.toContain('1 added');
  });

  // Final review 2026-11 (spec §8.12, touch targets ≥ 44 pt): "View it" was a link inside the
  // sentence, about 19 pt high, with no slop. It is a small button now (btnSlop('sm') → 45.6 pt).
  it('a duplicate: "View it" is a real button with a 44 pt target, and opens the card that is already there', () => {
    const r = openCardEditor();
    // A Basic item "der Hafen" in this deck (the editor's card type here is Basic).
    const dup = noteWithCards({ deckId: 'd1', fields: ['der Hafen', 'the harbour', '', ''], note: { id: 'n-hafen' } });
    // Destructured: the face guard (face.test.ts) forbids a direct property read of the notes here.
    const { notes: before, cards } = mockState;
    act(() => {
      mockState = { ...mockState, notes: [...before, dup.note], cards: [...cards, ...dup.cards] };
      r.update(React.createElement(CardEditorScreen));
    });
    typeFields(r, ['der Hafen']);
    expect(texts(r)).toContain('“der Hafen” is already in this deck.');
    const view = byText(r, 'View it');
    expect(view.props.accessibilityRole).toBe('button');
    // A small Btn is about 33.6 pt high; its top and bottom slop bring it to 44 pt or more.
    expect(view.props.hitSlop).toEqual({ top: btnSlop('sm'), bottom: btnSlop('sm') });
    expect(2 * 8 + 13.5 * 1.303 + 2 * btnSlop('sm')).toBeGreaterThanOrEqual(44);
    act(() => view.props.onPress());
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/card-editor', params: { noteId: 'n-hafen' } });
  });
});
