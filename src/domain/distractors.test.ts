/**
 * Quiz mode: distractors and the quiz pool (spec §6.3, unit W4-4 / A3).
 *
 * Pinned here: 3 distractors from the same deck + card type + direction,
 * never a sibling, never the same folded text (or a shared alternative),
 * the same badge value and a similar length are preferred, the order is a
 * seeded shuffle, and fewer than 3 → null (the card is a flashcard).
 */
import { describe, expect, it, jest } from '@jest/globals';

import { FIXED_NOW } from '../test/clock';
import { noteWithCards } from '../test/factoriesV3';
import { BUILTIN_TYPE_IDS, builtinType } from './builtinTypes';
import {
  createQuizPool,
  DISTRACTOR_COUNT,
  pickDistractors,
  QUIZ_GROUP_CAP,
  quizCandidate,
  quizGroup,
  quizQuestion,
  type QuizCandidate,
} from './distractors';
import { facesFor, type FaceOf } from './face';
import { libraryIndexOf } from './scope';
import { answerKey } from './answerCheck';
import type { Card, Note, NoteType } from './model';

const GROUP = quizGroup('d1', 'nt-x', 0);

/** A candidate written out by hand (the rules work on these). */
function cand(id: string, text: string, extra: Partial<QuizCandidate> = {}): QuizCandidate {
  return {
    id,
    noteId: `n-${id}`,
    group: GROUP,
    text,
    keys: [answerKey(text)],
    badges: [],
    length: text.length,
    ...extra,
  };
}

const SEED = 'c-target|2026-10-24';

describe('pickDistractors', () => {
  const target = cand('t', 'the hour');

  it('returns 3 distractors from the same group, never the target or a sibling', () => {
    const pool = [
      target,
      cand('sib', 'Stunde', { noteId: target.noteId }), // the other direction of the same note
      cand('other-deck', 'the day', { group: quizGroup('d2', 'nt-x', 0) }),
      cand('other-type', 'the week', { group: quizGroup('d1', 'nt-y', 0) }),
      cand('other-ord', 'the month', { group: quizGroup('d1', 'nt-x', 1) }),
      cand('a', 'the minute'),
      cand('b', 'the second'),
      cand('c', 'the year'),
    ];
    const picks = pickDistractors(target, pool, SEED);
    expect(picks).not.toBeNull();
    expect(picks!.map((p) => p.id).sort()).toEqual(['a', 'b', 'c']);
    expect(DISTRACTOR_COUNT).toBe(3);
  });

  it('never the same folded text as the answer, and no two choices with the same text', () => {
    const pool = [
      cand('same', 'The Hour.', { keys: [answerKey('The Hour.')] }),
      cand('d1', 'the day'),
      cand('d2', 'The day!', { keys: [answerKey('The day!')] }),
      cand('d3', 'THE DAY'),
      cand('e', 'the week'),
      cand('f', 'the year'),
    ];
    const picks = pickDistractors(target, pool, SEED)!;
    const keys = picks.map((p) => answerKey(p.text));
    expect(keys).not.toContain('the hour');
    expect(new Set(keys).size).toBe(3);
    expect(keys.filter((k) => k === 'the day')).toHaveLength(1);
  });

  it('never a choice that shares an alternative with the answer (a second right answer)', () => {
    const house = cand('t', 'house');
    const pool = [
      cand('bad', 'building, house', { keys: ['building, house', 'building', 'house'] }),
      cand('a', 'tree'),
      cand('b', 'car'),
      cand('c', 'road'),
    ];
    expect(pickDistractors(house, pool, SEED)!.map((p) => p.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('fewer than 3 usable distractors → null', () => {
    expect(pickDistractors(target, [cand('a', 'the day'), cand('b', 'the week')], SEED)).toBeNull();
    // Three candidates, but two share a text: only two distinct choices.
    expect(pickDistractors(target, [cand('a', 'the day'), cand('b', 'The day'), cand('c', 'the week')], SEED)).toBeNull();
    expect(pickDistractors(target, [], SEED)).toBeNull();
  });

  it('prefers the same badge value (same Level) over everything else', () => {
    const b1 = cand('t', 'to go', { badges: ['5:b1'] });
    const pool = [
      cand('a1-1', 'to do', { badges: ['5:a1'] }),
      cand('a1-2', 'to be', { badges: ['5:a1'] }),
      cand('a1-3', 'to see', { badges: ['5:a1'] }),
      cand('b1-1', 'to remember things', { badges: ['5:b1'] }), // longer, but the same level
      cand('b1-2', 'to arrive', { badges: ['5:b1'] }),
      cand('b1-3', 'to depart', { badges: ['5:b1'] }),
    ];
    for (const seed of ['s1', 's2', 's3']) {
      expect(pickDistractors(b1, pool, seed)!.map((p) => p.id).sort()).toEqual(['b1-1', 'b1-2', 'b1-3']);
    }
  });

  it('more shared badges win (same Level AND same Type)', () => {
    const noun = cand('t', 'the hour', { badges: ['5:a1', '6:noun'] });
    const pool = [
      cand('verb1', 'to walk', { badges: ['5:a1', '6:verb'] }),
      cand('verb2', 'to run', { badges: ['5:a1', '6:verb'] }),
      cand('noun1', 'the day', { badges: ['5:a1', '6:noun'] }),
      cand('noun2', 'the week', { badges: ['5:a1', '6:noun'] }),
      cand('noun3', 'the year', { badges: ['5:a1', '6:noun'] }),
    ];
    expect(pickDistractors(noun, pool, SEED)!.map((p) => p.id).sort()).toEqual(['noun1', 'noun2', 'noun3']);
  });

  it('then prefers a similar length', () => {
    const pool = [
      cand('long1', 'a unit of time of sixty minutes'),
      cand('long2', 'the time between two meals'),
      cand('s1', 'the day'),
      cand('s2', 'the week'),
      cand('s3', 'a year'),
    ];
    expect(pickDistractors(target, pool, SEED)!.map((p) => p.id).sort()).toEqual(['s1', 's2', 's3']);
  });

  it('is deterministic for a seed, and the seed varies the pick among equal candidates', () => {
    const pool = Array.from({ length: 30 }, (_, i) => cand(`c${i}`, `word ${String.fromCharCode(97 + (i % 26))}${i}`));
    const once = pickDistractors(target, pool, SEED)!.map((p) => p.id);
    expect(pickDistractors(target, pool, SEED)!.map((p) => p.id)).toEqual(once);
    const others = new Set<string>();
    for (let day = 1; day <= 10; day++) {
      others.add(pickDistractors(target, pool, `c-target|2026-10-${day}`)!.map((p) => p.id).join(','));
    }
    expect(others.size).toBeGreaterThan(1);
  });
});

describe('quizQuestion', () => {
  const target = cand('t', 'the hour');
  const pool = [cand('a', 'the day'), cand('b', 'the week'), cand('c', 'the year'), cand('d', 'the minute')];

  it('4 distinct choices; choices[answerIndex] is the right answer', () => {
    const q = quizQuestion(target, pool, SEED)!;
    expect(q.choices).toHaveLength(4);
    expect(new Set(q.choices).size).toBe(4);
    expect(q.choices[q.answerIndex]).toBe('the hour');
  });

  it('the order is a seeded shuffle: fixed for a seed, the right answer moves between seeds', () => {
    expect(quizQuestion(target, pool, SEED)).toEqual(quizQuestion(target, pool, SEED));
    const places = new Set<number>();
    for (let i = 0; i < 40; i++) places.add(quizQuestion(target, pool, `c-t|day-${i}`)!.answerIndex);
    expect(places.size).toBeGreaterThan(2);
  });

  it('null when there are fewer than 3 distractors', () => {
    expect(quizQuestion(target, pool.slice(0, 2), SEED)).toBeNull();
  });
});

/* ------------------------------------------------------------ real cards */

/** A library of real notes and cards, with its face function. */
function library(groups: { note: Note; cards: Card[] }[], types: NoteType[]) {
  const notes = groups.map((g) => g.note);
  const cards = groups.flatMap((g) => g.cards);
  const index = libraryIndexOf({ notes, noteTypes: types });
  return { cards, index, faceOf: facesFor(index) };
}

/** A German word note (legacy type: Word, Translation, …, Level at 5, Type at 6). */
function word(deckId: string, de: string, en: string, level = 'A1', typ = 'noun') {
  return noteWithCards({
    deckId,
    typeId: BUILTIN_TYPE_IDS.legacyVocabDe,
    fields: [de, en, '', '', '', level, typ, '', '', ''],
  });
}

describe('quizCandidate', () => {
  it('reads the answer, its keys and its badges from the face', () => {
    const types = [builtinType('legacyVocabDe', FIXED_NOW)];
    const g = word('d1', 'die Stunde', 'the hour, the lesson', 'B1', 'Noun');
    const lib = library([g], types);
    const c = quizCandidate(g.cards[0], lib.faceOf(g.cards[0]), BUILTIN_TYPE_IDS.legacyVocabDe)!;
    expect(c).toMatchObject({
      id: g.cards[0].id,
      noteId: g.note.id,
      group: quizGroup('d1', BUILTIN_TYPE_IDS.legacyVocabDe, 0),
      text: 'the hour, the lesson',
      keys: ['the hour, the lesson', 'the hour', 'the lesson'],
      badges: ['5:b1', '6:noun'],
    });
  });

  it('null when the answer has no text', () => {
    const types = [builtinType('basic', FIXED_NOW)];
    const g = noteWithCards({ deckId: 'd1', typeId: BUILTIN_TYPE_IDS.basic, fields: ['front', '', '', ''] });
    const lib = library([g], types);
    expect(quizCandidate(g.cards[0], lib.faceOf(g.cards[0]), BUILTIN_TYPE_IDS.basic)).toBeNull();
  });
});

describe('createQuizPool', () => {
  const types = [builtinType('legacyVocabDe', FIXED_NOW), builtinType('basicReverse', FIXED_NOW)];

  it('distractors come from the same deck, card type and direction; never a sibling', () => {
    const target = noteWithCards({
      deckId: 'd1',
      typeId: BUILTIN_TYPE_IDS.basicReverse,
      fields: ['die Stunde', 'the hour', '', ''],
    });
    const sameDeckSameDir = ['der Tag/the day', 'die Woche/the week', 'das Jahr/the year', 'die Minute/the minute'].map(
      (pair) => {
        const [de, en] = pair.split('/');
        return noteWithCards({ deckId: 'd1', typeId: BUILTIN_TYPE_IDS.basicReverse, fields: [de, en, '', ''] });
      },
    );
    const otherDeck = noteWithCards({ deckId: 'd2', typeId: BUILTIN_TYPE_IDS.basicReverse, fields: ['x', 'the night', '', ''] });
    const otherType = word('d1', 'der Monat', 'the month');
    const lib = library([target, ...sameDeckSameDir, otherDeck, otherType], types);
    const quiz = createQuizPool(lib.cards, lib.index, lib.faceOf, '2026-10-24');

    const forward = target.cards.find((c) => c.ord === 0)!;
    const q = quiz.question(forward, SEED)!;
    expect(q.choices[q.answerIndex]).toBe('the hour');
    const wrong = q.choices.filter((_, i) => i !== q.answerIndex);
    expect(wrong).toHaveLength(3);
    for (const text of wrong) {
      // Only English answers of ord 0 in deck d1 and the Basic + reverse type.
      expect(['the day', 'the week', 'the year', 'the minute']).toContain(text);
    }
    // The reverse direction asks for the German word: its choices are German, never 'the hour' (its sibling).
    const reverse = target.cards.find((c) => c.ord === 1)!;
    const r = quiz.question(reverse, SEED)!;
    expect(r.choices[r.answerIndex]).toBe('die Stunde');
    for (const text of r.choices) expect(text).not.toBe('the hour');
  });

  it('nouns written "X, -en" are a quiz: the shared suffix note is not a shared answer', () => {
    // Basic: the question is the English word, the answer is the German word-list entry.
    const entries = [
      ['the departure', 'die Abfahrt, -en'],
      ['the newspaper', 'die Zeitung, -en'],
      ['the flat', 'die Wohnung, -en'],
      ['the bill', 'die Rechnung, -en'],
    ];
    const groups = entries.map(([en, de]) =>
      noteWithCards({ deckId: 'd1', typeId: BUILTIN_TYPE_IDS.basic, fields: [en, de, '', ''] }),
    );
    const lib = library(groups, [builtinType('basic', FIXED_NOW)]);
    const candidate = quizCandidate(groups[0].cards[0], lib.faceOf(groups[0].cards[0]), BUILTIN_TYPE_IDS.basic)!;
    expect(candidate.keys).toEqual(['die abfahrt, -en', 'die abfahrt']);

    const quiz = createQuizPool(lib.cards, lib.index, lib.faceOf, '2026-10-24');
    const q = quiz.question(groups[0].cards[0], SEED);
    expect(q).not.toBeNull();
    expect(q!.choices[q!.answerIndex]).toBe('die Abfahrt, -en');
    expect([...q!.choices].sort()).toEqual(entries.map(([, de]) => de).sort());
  });

  it('German "der/die X" nouns are a quiz: their keys never hold a bare "der"', () => {
    // Basic + reverse with a German Front; ord 1 (Back → Front) asks for the German word.
    const base = builtinType('basicReverse', FIXED_NOW);
    const deReverse: NoteType = {
      ...base,
      id: 'nt-de-reverse',
      fields: base.fields.map((f, i) => (i === 0 ? { ...f, lang: 'de-DE' } : f)),
    };
    const entries = [
      ['der/die Angestellte', 'the employee'],
      ['der/die Verwandte', 'the relative'],
      ['der/die Bekannte', 'the acquaintance'],
      ['der/die Deutsche', 'the German'],
      ['der Tisch', 'the table'],
      ['die Lampe', 'the lamp'],
    ];
    const groups = entries.map(([de, en]) =>
      noteWithCards({ deckId: 'd1', typeId: deReverse.id, fields: [de, en, '', ''], ords: [1] }, [deReverse]),
    );
    const lib = library(groups, [deReverse]);
    const target = groups[0].cards[0];
    const candidate = quizCandidate(target, lib.faceOf(target), deReverse.id)!;
    expect(candidate.keys).toEqual(['der/die angestellte', 'der angestellte', 'die angestellte']);
    expect(candidate.keys).not.toContain('der');
    expect(candidate.keys).not.toContain('die');

    const quiz = createQuizPool(lib.cards, lib.index, lib.faceOf, '2026-10-24');
    const q = quiz.question(target, SEED);
    expect(q).not.toBeNull();
    expect(q!.choices[q!.answerIndex]).toBe('der/die Angestellte');
    expect(new Set(q!.choices).size).toBe(4);
    // Every "der/die" noun can be a distractor of another one.
    const all = groups.map((g) => quizCandidate(g.cards[0], lib.faceOf(g.cards[0]), deReverse.id)!);
    const pool = all.filter((c) => c.text.startsWith('der/die'));
    expect(pickDistractors(all[0], pool, SEED)!.map((c) => c.text).sort()).toEqual([
      'der/die Bekannte',
      'der/die Deutsche',
      'der/die Verwandte',
    ]);
  });

  it('fewer than 3 distractors in the deck → null', () => {
    const groups = [word('d1', 'die Stunde', 'the hour'), word('d1', 'der Tag', 'the day'), word('d1', 'die Woche', 'the week')];
    const lib = library(groups, types);
    const quiz = createQuizPool(lib.cards, lib.index, lib.faceOf);
    expect(quiz.question(groups[0].cards[0], SEED)).toBeNull();
  });

  it('builds nothing until the first question, and keeps what it built', () => {
    const groups = ['a', 'b', 'c', 'd', 'e'].map((x) => word('d1', `das ${x.toUpperCase()}`, `the ${x}`));
    const lib = library(groups, types);
    const faceOf = jest.fn(lib.faceOf) as unknown as FaceOf;
    const quiz = createQuizPool(lib.cards, lib.index, faceOf);
    expect(jest.mocked(faceOf)).not.toHaveBeenCalled();
    const first = quiz.question(groups[0].cards[0], SEED);
    expect(first).not.toBeNull();
    const calls = jest.mocked(faceOf).mock.calls.length;
    expect(quiz.question(groups[0].cards[0], SEED)).toBe(first); // the same object, nothing built again
    expect(jest.mocked(faceOf).mock.calls.length).toBe(calls);
  });

  it(`reads at most ${QUIZ_GROUP_CAP} candidates of a big group`, () => {
    const groups = Array.from({ length: QUIZ_GROUP_CAP + 300 }, (_, i) => word('d1', `das Wort${i}`, `word ${i}`));
    const lib = library(groups, types);
    const faceOf = jest.fn(lib.faceOf) as unknown as FaceOf;
    const quiz = createQuizPool(lib.cards, lib.index, faceOf, '2026-10-24');
    const q = quiz.question(groups[0].cards[0], SEED);
    expect(q).not.toBeNull();
    // The cap, plus the target itself.
    expect(jest.mocked(faceOf).mock.calls.length).toBeLessThanOrEqual(QUIZ_GROUP_CAP + 1);
  });

  it('a card without a note (no card type) gets no quiz', () => {
    const groups = ['a', 'b', 'c', 'd'].map((x) => word('d1', `das ${x.toUpperCase()}`, `the ${x}`));
    const lib = library(groups, types);
    const quiz = createQuizPool(lib.cards, lib.index, lib.faceOf);
    const orphan = { ...groups[0].cards[0], id: 'orphan', noteId: 'missing-note' };
    expect(quiz.question(orphan, SEED)).toBeNull();
  });
});
