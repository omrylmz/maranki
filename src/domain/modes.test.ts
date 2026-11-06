/**
 * Study modes (spec §6.3, unit W4-4 / A3): the per-card plan, Mixed,
 * fallbacks, the Articles eligibility, the suggested rating, and the
 * ModeSheet that shows the modes (src/components/study/ModeSheet.tsx).
 *
 * Module mocks (`jest.mock` below), only for the ModeSheet render tests at
 * the end (the same as src/components/ui/uiKit.test.ts):
 *   - ThemeContext → useColors() returns the light palette;
 *   - safe-area-context → zero insets (Sheet);
 *   - @expo/vector-icons → icons render nothing (no async font load).
 */
// '@jest/globals' first: the jest.mock factories below use its `jest`.
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { MODE_SCOPE_COPY, MODE_SHEET_TITLES, ModeSheet } from '../components/study/ModeSheet';
import { FIXED_NOW } from '../test/clock';
import { cardInLifeV3, lifeValues, noteWithCards } from '../test/factoriesV3';
import { BUILTIN_TYPE_IDS, builtinType } from './builtinTypes';
import { createQuizPool } from './distractors';
import { facesFor } from './face';
import type { Card, LifeKey, Note, NoteType, SessionKind, StudyMode } from './model';
import {
  ARTICLE_CHOICES,
  ARTICLE_MIN_CARDS,
  articleCards,
  articleQuestion,
  canOfferArticles,
  firstForm,
  isStudyMode,
  mixModeFor,
  MODE_HINTS,
  MODE_LABELS,
  modeChoices,
  modeSeed,
  parseStudyMode,
  planCard,
  planCards,
  type PlanCtx,
  shownWays,
  STUDY_MODES,
  suggestRating,
  wayTitle,
} from './modes';
import { libraryIndexOf } from './scope';

jest.mock('../theme/ThemeContext', () => ({
  useColors: () => jest.requireActual<typeof import('../theme/tokens')>('../theme/tokens').light,
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

const DAY_KEY = '2026-10-24';
const LEGACY_DE = BUILTIN_TYPE_IDS.legacyVocabDe;

/* ------------------------------------------------------------ fixtures */

/** The German words type, plus a Basic + reverse type whose Front is German. */
const germanReverse: NoteType = (() => {
  const base = builtinType('basicReverse', FIXED_NOW);
  return {
    ...base,
    id: 'nt-de-reverse',
    fields: base.fields.map((f, i) => (i === 0 ? { ...f, lang: 'de-DE' } : f)),
  };
})();
const TYPES: NoteType[] = [builtinType('legacyVocabDe', FIXED_NOW), builtinType('basic', FIXED_NOW), germanReverse];

/** A German word note in deck d1 (legacy type: 0 Word, 1 Translation, 5 Level, 6 Type). */
function deWord(de: string, en: string, life: LifeKey = 'new') {
  return noteWithCards({
    deckId: 'd1',
    typeId: LEGACY_DE,
    fields: [de, en, '', '', '', 'A1', 'noun', '', '', ''],
    card: lifeValues(life, FIXED_NOW),
  });
}

/** A plan ctx over these notes and cards (a Study session unless `kind` says otherwise). */
function ctxOf(
  groups: { note: Note; cards: Card[] }[],
  mode: StudyMode,
  withQuiz = true,
  kind: SessionKind = 'scheduled',
): PlanCtx & { cards: Card[] } {
  const notes = groups.map((g) => g.note);
  const cards = groups.flatMap((g) => g.cards);
  const library = libraryIndexOf({ notes, noteTypes: TYPES });
  const faceOf = facesFor(library);
  return {
    mode,
    kind,
    dayKey: DAY_KEY,
    faceOf,
    library,
    quiz: withQuiz ? createQuizPool(cards, library, faceOf, DAY_KEY) : null,
    cards,
  };
}

/** Five ordinary German nouns: enough for a quiz (1 right + 3 wrong + 1 spare). */
const filler = () =>
  [
    ['der Tag', 'the day'],
    ['die Woche', 'the week'],
    ['das Jahr', 'the year'],
    ['die Minute', 'the minute'],
  ].map(([de, en]) => deWord(de, en));

/* ---------------------------------------------------------------- modes */

describe('modes, labels and the ModeSheet row', () => {
  it('labels use the UI words (spec §8.11: "Quiz" / "Typing")', () => {
    expect(STUDY_MODES.map((m) => MODE_LABELS[m])).toEqual(['Flashcards', 'Typing', 'Quiz', 'Mixed', 'Articles']);
    for (const m of STUDY_MODES) expect(MODE_HINTS[m].length).toBeGreaterThan(0);
  });

  it('the mode row is Flashcards · Typing · Quiz · Mixed, + Articles only when asked', () => {
    expect(modeChoices(false)).toEqual(['flash', 'type', 'mc', 'mix']);
    expect(modeChoices(true)).toEqual(['flash', 'type', 'mc', 'mix', 'article']);
  });

  it('parses a mode route param', () => {
    expect(isStudyMode('mc')).toBe(true);
    expect(isStudyMode('quiz')).toBe(false);
    expect(isStudyMode(undefined)).toBe(false);
    expect(parseStudyMode('article', 'flash')).toBe('article');
    expect(parseStudyMode(['mc'], 'flash')).toBe('flash');
  });

  it('the seed is the card id and the day', () => {
    expect(modeSeed('c-1', DAY_KEY)).toBe('c-1|2026-10-24');
  });
});

/* ---------------------------------------------------------------- mixed */

describe('Mixed: a mode per card by its status', () => {
  const table: [LifeKey, 'flash' | 'type' | 'mc'][] = [
    ['notStarted', 'flash'],
    ['new', 'flash'],
    ['learning', 'mc'],
    ['review', 'type'],
    ['mastered', 'type'],
    ['known', 'type'], // a Check
  ];
  it.each(table)('%s → %s', (life, mode) => {
    expect(mixModeFor(cardInLifeV3(life))).toBe(mode);
  });

  it('plans each card as the table says', () => {
    const fresh = deWord('die Stunde', 'the hour', 'new');
    const learning = deWord('die Abfahrt', 'the departure', 'learning');
    const review = deWord('das Haus', 'the house', 'review');
    const check = deWord('der Hund', 'the dog', 'known');
    const ctx = ctxOf([fresh, learning, review, check, ...filler()], 'mix');
    expect(planCard(fresh.cards[0], ctx)).toMatchObject({ mode: 'flash', fallback: null });
    const quiz = planCard(learning.cards[0], ctx);
    expect(quiz.mode).toBe('mc');
    expect(quiz.quiz!.choices[quiz.quiz!.answerIndex]).toBe('the departure');
    expect(planCard(review.cards[0], ctx)).toMatchObject({
      mode: 'type',
      fallback: null,
      typing: { text: 'the house', role: 'meaning', lang: 'en-US' },
    });
    expect(planCard(check.cards[0], ctx).mode).toBe('type');
  });

  it('a long review answer or a learning card without 3 distractors is a flashcard, with no fallback message', () => {
    const longReview = deWord('sein', 'x'.repeat(70), 'review');
    const lonelyLearning = deWord('die Stunde', 'the hour', 'learning');
    const ctx = ctxOf([longReview, lonelyLearning], 'mix');
    expect(planCard(longReview.cards[0], ctx)).toMatchObject({ mode: 'flash', fallback: null });
    expect(planCard(lonelyLearning.cards[0], ctx)).toMatchObject({ mode: 'flash', fallback: null });
  });

  it('is deterministic: the same plans every time, whatever the order of the queue', () => {
    const groups = [deWord('die Stunde', 'the hour', 'learning'), deWord('das Haus', 'the house', 'review'), ...filler()];
    const a = ctxOf(groups, 'mix');
    const b = ctxOf(groups, 'mix');
    const queue = a.cards;
    const once = planCards(queue, a);
    expect(planCards([...queue].reverse(), b)).toEqual(once);
    // A re-queued copy ("Again") has the same id: it keeps its plan.
    const again = planCards([...queue, { ...queue[0] }], a);
    expect(again.size).toBe(queue.length);
    expect(again.get(queue[0].id)).toEqual(once.get(queue[0].id));
  });
});

/* ------------------------------------------------------------ fallbacks */

describe('explicit modes and their fallbacks', () => {
  it('Flashcards is always a flashcard', () => {
    const g = deWord('die Stunde', 'the hour', 'review');
    expect(planCard(g.cards[0], ctxOf([g], 'flash'))).toEqual({
      mode: 'flash',
      fallback: null,
      typing: null,
      quiz: null,
      article: null,
    });
  });

  it('Typing: a short answer is typed; a long one or one with line breaks is flipped ("long")', () => {
    const short = deWord('die Stunde', 'the hour', 'new');
    const long = deWord('sein', 'x'.repeat(61), 'new');
    const lines = deWord('sein', 'ich bin<br>du bist', 'new');
    const ctx = ctxOf([short, long, lines], 'type');
    expect(planCard(short.cards[0], ctx)).toMatchObject({ mode: 'type', typing: { text: 'the hour' } });
    expect(planCard(long.cards[0], ctx)).toMatchObject({ mode: 'flash', fallback: 'long' });
    expect(planCard(lines.cards[0], ctx)).toMatchObject({ mode: 'flash', fallback: 'long' });
  });

  it('Typing: an answer with no text is flipped ("noText")', () => {
    const g = noteWithCards({ deckId: 'd1', typeId: BUILTIN_TYPE_IDS.basic, fields: ['front', '', '', ''] });
    expect(planCard(g.cards[0], ctxOf([g], 'type'))).toMatchObject({ mode: 'flash', fallback: 'noText' });
  });

  it('Typing: an answer of only punctuation ("?", "...") is "noText", never "long"', () => {
    const question = noteWithCards({ deckId: 'd1', typeId: BUILTIN_TYPE_IDS.basic, fields: ['question mark', '?', '', ''] });
    const dots = noteWithCards({ deckId: 'd1', typeId: BUILTIN_TYPE_IDS.basic, fields: ['ellipsis', '...', '', ''] });
    const ctx = ctxOf([question, dots], 'type');
    expect(planCard(question.cards[0], ctx)).toMatchObject({ mode: 'flash', fallback: 'noText' });
    expect(planCard(dots.cards[0], ctx)).toMatchObject({ mode: 'flash', fallback: 'noText' });
  });

  it('Quiz: 4 choices when the deck has 3 distractors, else a flashcard ("fewChoices")', () => {
    const target = deWord('die Stunde', 'the hour', 'new');
    const rich = ctxOf([target, ...filler()], 'mc');
    const plan = planCard(target.cards[0], rich);
    expect(plan.mode).toBe('mc');
    expect(plan.quiz!.choices).toHaveLength(4);
    const poor = ctxOf([target, deWord('der Tag', 'the day')], 'mc');
    expect(planCard(target.cards[0], poor)).toMatchObject({ mode: 'flash', fallback: 'fewChoices' });
    const noPool = ctxOf([target, ...filler()], 'mc', false);
    expect(planCard(target.cards[0], noPool)).toMatchObject({ mode: 'flash', fallback: 'fewChoices' });
  });

  it('Quiz: the choices are seeded by card and day', () => {
    const target = deWord('die Stunde', 'the hour', 'new');
    const groups = [target, ...filler()];
    expect(planCard(target.cards[0], ctxOf(groups, 'mc')).quiz).toEqual(planCard(target.cards[0], ctxOf(groups, 'mc')).quiz);
    const orders = new Set<string>();
    for (let d = 1; d <= 20; d++) {
      const ctx = { ...ctxOf(groups, 'mc'), dayKey: `2026-10-${String(d).padStart(2, '0')}` };
      orders.add(planCard(target.cards[0], ctx).quiz!.choices.join('|'));
    }
    expect(orders.size).toBeGreaterThan(1);
  });
});

/* ------------------------------------------------------------- articles */

describe('Articles practice', () => {
  it('asks for a German singular noun', () => {
    const g = deWord('die Abfahrt', 'the departure');
    const { faceOf } = ctxOf([g], 'article');
    expect(articleQuestion(faceOf(g.cards[0]))).toEqual({ article: 'die', word: 'Abfahrt', gender: 'f', lang: 'de-DE' });
    expect(ARTICLE_CHOICES).toEqual(['der', 'die', 'das']);
  });

  it('not for plurals, "der/die", words without an article, or other languages', () => {
    const plural = deWord('die Eltern (Pl.)', 'the parents');
    const both = deWord('der/die Angestellte', 'the employee');
    const verb = deWord('gehen', 'to go');
    const english = noteWithCards({ deckId: 'd1', typeId: BUILTIN_TYPE_IDS.basic, fields: ['die Stunde', 'the hour', '', ''] });
    const { faceOf } = ctxOf([plural, both, verb, english], 'article');
    for (const g of [plural, both, verb, english]) expect(articleQuestion(faceOf(g.cards[0]))).toBeNull();
  });

  it('a term with two forms asks for the FIRST form only: "der Zauberer / die Zauberin" → Zauberer, der (wave 5h, E7 note 5)', () => {
    const shapes: [string, string, 'der' | 'die' | 'das'][] = [
      ['der Zauberer / die Zauberin', 'Zauberer', 'der'],
      ['der Zauberer/die Zauberin', 'Zauberer', 'der'], // no spaces around "/"
      ['die Kundin, der Kunde', 'Kundin', 'die'],
      ['das Haus; die Häuser', 'Haus', 'das'],
      ['der Tisch, -e', 'Tisch', 'der'], // a plural ending after the comma
      ['der Kuli (Kugelschreiber, ugs.)', 'Kuli (Kugelschreiber, ugs.)', 'der'], // a comma inside brackets is not a form
    ];
    for (const [term, word, article] of shapes) {
      const g = deWord(term, 'meaning');
      const { faceOf } = ctxOf([g], 'article');
      const q = articleQuestion(faceOf(g.cards[0]));
      expect(q).toMatchObject({ article, word });
      // The question never holds a second article: the bare word is all the learner sees.
      expect(q!.word).not.toMatch(/\b(der|die|das)\b/i);
    }
  });

  it('a term with two forms is NOT an Articles card when its first form is not a singular noun', () => {
    const shapes = [
      'der / die Angestellte', // the first form is only an article
      'die Eltern (Pl.) / der Elternteil', // the first form is a plural
      'Zauberer / der Zauberer', // the first form has no article
      'der/die Angestellte', // two articles (as before)
    ];
    for (const term of shapes) {
      const g = deWord(term, 'meaning');
      const { faceOf } = ctxOf([g], 'article');
      expect(articleQuestion(faceOf(g.cards[0]))).toBeNull();
    }
    expect(firstForm('der/die Angestellte')).toBe('der');
    expect(firstForm('  die Abfahrt  ')).toBe('die Abfahrt');
    expect(firstForm('die Reise [f], die Reisen')).toBe('die Reise [f]');
  });

  it('two-form terms count for the "≥ 4 such cards" offer exactly like the queue (one rule: articleQuestion)', () => {
    const nouns = [
      deWord('der Zauberer / die Zauberin', 'the wizard'),
      deWord('der Kunde, die Kundin', 'the customer'),
      deWord('die Abfahrt', 'the departure'),
      deWord('der / die Angestellte', 'the employee'), // not an Articles card
      deWord('das Jahr; die Jahre', 'the year'),
    ];
    const ctx = ctxOf(nouns, 'article', false, 'practice');
    const picked = articleCards(ctx.cards, ctx.faceOf, 0);
    expect(picked.map((c) => c.noteId)).toEqual([nouns[0], nouns[1], nouns[2], nouns[4]].map((g) => g.note.id));
    expect(canOfferArticles(picked.length)).toBe(true);
    // Without "das Jahr; die Jahre": 3 Articles cards (the "der / die" term never counts), so no offer.
    const fewer = ctxOf(nouns.slice(0, 4), 'article', false, 'practice');
    expect(articleCards(fewer.cards, fewer.faceOf, 0)).toHaveLength(3);
    expect(canOfferArticles(articleCards(fewer.cards, fewer.faceOf, 0).length)).toBe(false);
    // The session plans each picked card as an Articles question with the first form's article.
    expect(picked.map((c) => planCard(c, ctx).article?.article)).toEqual(['der', 'der', 'die', 'das']);
  });

  it('finds the German term on the answer side too (the reverse direction)', () => {
    const g = noteWithCards({ deckId: 'd1', typeId: germanReverse.id, fields: ['das Haus', 'the house', '', ''] }, TYPES);
    const { faceOf } = ctxOf([g], 'article');
    const reverse = g.cards.find((c) => c.ord === 1)!;
    expect(articleQuestion(faceOf(reverse))).toMatchObject({ article: 'das', word: 'Haus', gender: 'n' });
  });

  it('articleCards: only nouns, one card per note, in order', () => {
    const haus = noteWithCards({ deckId: 'd1', typeId: germanReverse.id, fields: ['das Haus', 'the house', '', ''] }, TYPES);
    const verb = deWord('gehen', 'to go');
    const stunde = deWord('die Stunde', 'the hour');
    const ctx = ctxOf([haus, verb, stunde], 'article');
    const picked = articleCards(ctx.cards, ctx.faceOf, 0);
    expect(picked.map((c) => c.id)).toEqual([haus.cards[0].id, stunde.cards[0].id]);
  });

  it('articleCards: never more cards than the session size, so the button count is the queue', () => {
    // 12 nouns (24 cards: both directions), session size 5.
    const nouns = Array.from({ length: 12 }, (_, i) =>
      noteWithCards({ deckId: 'd1', typeId: germanReverse.id, fields: [`das Wort${i}`, `word ${i}`, '', ''] }, TYPES),
    );
    const ctx = ctxOf(nouns, 'article', false, 'practice');
    const picked = articleCards(ctx.cards, ctx.faceOf, 5);
    expect(picked).toHaveLength(5);
    // The first 5 NOTES in order, one card each: the cap counts cards after the one-per-note rule.
    expect(picked.map((c) => c.noteId)).toEqual(nouns.slice(0, 5).map((g) => g.note.id));
    // The same call gives the same cards (the button and the session agree).
    expect(articleCards(ctx.cards, ctx.faceOf, 5)).toEqual(picked);
    // Session size 0 (or a broken value) = no cap.
    expect(articleCards(ctx.cards, ctx.faceOf, 0)).toHaveLength(12);
    expect(articleCards(ctx.cards, ctx.faceOf, Number.NaN)).toHaveLength(12);
    expect(articleCards(ctx.cards, ctx.faceOf, 50)).toHaveLength(12);
  });

  it(`ModeSheet offers Articles from ${ARTICLE_MIN_CARDS} nouns`, () => {
    expect(canOfferArticles(3)).toBe(false);
    expect(canOfferArticles(4)).toBe(true);
  });

  it('plans an article question in Practice, or a flashcard for a word without one ("noArticle")', () => {
    const noun = deWord('die Abfahrt', 'the departure');
    const verb = deWord('gehen', 'to go');
    const ctx = ctxOf([noun, verb], 'article', true, 'practice');
    expect(planCard(noun.cards[0], ctx)).toMatchObject({ mode: 'article', article: { article: 'die' } });
    expect(planCard(verb.cards[0], ctx)).toMatchObject({ mode: 'flash', fallback: 'noArticle' });
  });

  it('Articles is Practice only: in a session that changes the schedule, a noun is a plain flashcard (still rated)', () => {
    const noun = deWord('die Abfahrt', 'the departure');
    for (const kind of ['scheduled', 'ahead', 'cram', 'hardest', 'deck', 'collection'] as const) {
      expect(planCard(noun.cards[0], ctxOf([noun], 'article', true, kind))).toEqual({
        mode: 'flash',
        fallback: null,
        typing: null,
        quiz: null,
        article: null,
      });
    }
  });
});

/* ------------------------------------------------------ suggested rating */

describe('suggestRating', () => {
  it('Typing: exact → Good, close → Hard, wrong → Again', () => {
    expect(suggestRating({ mode: 'type', verdict: 'exact' })).toBe('good');
    expect(suggestRating({ mode: 'type', verdict: 'close' })).toBe('hard');
    expect(suggestRating({ mode: 'type', verdict: 'wrong' })).toBe('again');
  });

  it('Quiz: right → Good, wrong → Again; Flashcards: no suggestion', () => {
    expect(suggestRating({ mode: 'mc', right: true })).toBe('good');
    expect(suggestRating({ mode: 'mc', right: false })).toBe('again');
    expect(suggestRating({ mode: 'flash' })).toBeNull();
  });

  it('a used hint outlines Hard, but a wrong answer stays Again', () => {
    expect(suggestRating({ mode: 'flash' }, true)).toBe('hard');
    expect(suggestRating({ mode: 'type', verdict: 'exact' }, true)).toBe('hard');
    expect(suggestRating({ mode: 'type', verdict: 'wrong' }, true)).toBe('again');
  });
});

/* -------------------------------------------------------- ModeSheet rows */

describe('ways to study', () => {
  const noop = () => undefined;

  it('only rows with a count above 0 are shown', () => {
    const ways = [
      { key: 'ahead', label: 'Study ahead', count: 12, onPress: noop },
      { key: 'all', label: 'Practice all', count: 0, onPress: noop },
      { key: 'odd', label: 'Odd', count: Number.NaN, onPress: noop },
    ];
    expect(shownWays(ways).map((w) => w.key)).toEqual(['ahead']);
    expect(shownWays(undefined)).toEqual([]);
  });

  it('a row title is "{label} · {n}"', () => {
    expect(wayTitle('Study ahead', 12)).toBe('Study ahead · 12');
    expect(wayTitle('Practice all', 1240)).toBe('Practice all · 1,240');
  });
});

/* --------------------------------------------------------- ModeSheet UI */

const h = React.createElement;
let renderer: ReactTestRenderer | null = null;

afterEach(() => {
  if (renderer) act(() => renderer!.unmount());
  renderer = null;
  jest.useRealTimers();
});

function render(element: React.ReactElement): ReactTestRenderer {
  jest.useFakeTimers();
  act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer!;
}

/** Every string drawn by a Text. */
function texts(r: ReactTestRenderer): string[] {
  return r.root.findAllByType(Text).map((t) => (typeof t.props.children === 'string' ? t.props.children : ''));
}

/** The chip (a Pressable with this label). */
function chip(r: ReactTestRenderer, label: string): ReactTestInstance | undefined {
  return r.root.findAll(
    (n) => typeof n.type !== 'string' && n.props.accessibilityLabel === label && typeof n.props.onPress === 'function',
  )[0];
}

/** Press the nearest pressable around the Text that shows `text`. */
function pressText(r: ReactTestRenderer, text: string): void {
  let node: ReactTestInstance | null = r.root.findAllByType(Text).find((t) => t.props.children === text) ?? null;
  while (node && !(typeof node.type !== 'string' && typeof node.props.onPress === 'function')) node = node.parent;
  if (!node) throw new Error(`nothing to press around "${text}"`);
  const target = node;
  act(() => target.props.onPress());
}

describe('ModeSheet', () => {
  it('in the session: "Switch mode", the four modes, the hint of the current mode', () => {
    const r = render(h(ModeSheet, { open: true, onClose: jest.fn(), current: 'type', onPickMode: jest.fn() }));
    const shown = texts(r);
    expect(shown).toContain(MODE_SHEET_TITLES.session);
    expect(MODE_SHEET_TITLES.session).toBe('Switch mode');
    for (const label of ['Flashcards', 'Typing', 'Quiz', 'Mixed']) expect(chip(r, label)).toBeDefined();
    expect(chip(r, 'Articles')).toBeUndefined();
    expect(chip(r, 'Typing')!.props.accessibilityState).toEqual({ selected: true });
    expect(shown).toContain(MODE_HINTS.type);
    expect(shown).toContain(MODE_SCOPE_COPY);
    // The Settings row is called "Default mode" (spec §8.6): the sheet uses the same word.
    expect(MODE_SCOPE_COPY).toBe('Only for this session. Your default mode is in Settings.');
  });

  it('Articles only with showArticle', () => {
    const r = render(h(ModeSheet, { open: true, onClose: jest.fn(), current: 'flash', onPickMode: jest.fn(), showArticle: true }));
    expect(chip(r, 'Articles')).toBeDefined();
  });

  it('never an Articles chip on the deck page: there it is the "Practice articles" row (spec §8.2)', () => {
    const ways = [{ key: 'articles', label: 'Practice articles', count: 86, onPress: jest.fn() }];
    const r = render(
      h(ModeSheet, { open: true, onClose: jest.fn(), current: 'flash', onPickMode: jest.fn(), ways, showArticle: true }),
    );
    expect(texts(r)).toContain('Practice articles · 86');
    for (const label of ['Flashcards', 'Typing', 'Quiz', 'Mixed']) expect(chip(r, label)).toBeDefined();
    expect(chip(r, 'Articles')).toBeUndefined();
  });

  it('picking a mode in the session calls onPickMode and closes; the current mode only closes', () => {
    const onClose = jest.fn();
    const onPickMode = jest.fn();
    const r = render(h(ModeSheet, { open: true, onClose, current: 'flash', onPickMode }));
    act(() => chip(r, 'Quiz')!.props.onPress());
    expect(onPickMode).toHaveBeenCalledWith('mc');
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => chip(r, 'Flashcards')!.props.onPress());
    expect(onPickMode).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('on the deck page: "More ways to study", rows with a count only, a row closes then opens', () => {
    const calls: string[] = [];
    const onClose = jest.fn(() => calls.push('close'));
    const onPickMode = jest.fn();
    const ways = [
      { key: 'ahead', label: 'Study ahead', count: 12, onPress: () => calls.push('ahead') },
      { key: 'all', label: 'Practice all', count: 1240, sub: 'Doesn’t change your schedule.', onPress: () => calls.push('all') },
      { key: 'hardest', label: 'Practice your hardest', count: 0, onPress: () => calls.push('hardest') },
    ];
    const r = render(h(ModeSheet, { open: true, onClose, current: 'flash', onPickMode, ways }));
    const shown = texts(r);
    expect(shown).toContain(MODE_SHEET_TITLES.deck);
    expect(MODE_SHEET_TITLES.deck).toBe('More ways to study');
    expect(shown).toContain('Study ahead · 12');
    expect(shown).toContain('Practice all · 1,240');
    expect(shown).toContain('Doesn’t change your schedule.');
    expect(shown.some((t) => t.startsWith('Practice your hardest'))).toBe(false);

    pressText(r, 'Practice all · 1,240');
    expect(calls).toEqual(['close', 'all']);

    // Picking a mode here keeps the sheet open: a way is still to be chosen.
    act(() => chip(r, 'Mixed')!.props.onPress());
    expect(onPickMode).toHaveBeenCalledWith('mix');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
