/**
 * Baseline characterization tests for XP, levels and achievements.
 * Locks in current behavior; the pct-rounding and freeze-economy fixes
 * arrive in a later phase and extend this file.
 *
 * W3-1: the mastery rule — the Mastery achievements count `isMastered`
 * cards (graduated, interval ≥ 21 days, NOT Known), derived from the cards,
 * so 2,000 Known cards unlock nothing.
 *
 * W4-6: neutral level names (spec §8.8, §7 #47) and the content pack's
 * `levelNames` override (spec §9.4).
 */
import { describe, expect, test } from '@jest/globals';

import { cardInLifeV3 } from '../test/factoriesV3';
import { pack as genericPack } from '../variants/generic/pack';
import {
  AchievementContext,
  achievementStatuses,
  completionTier,
  countMastered,
  LEVEL_NAMES,
  levelInfo,
  levelName,
  levelNames,
  newlyUnlocked,
  sessionXpItems,
  sessionXpTotal,
  xpForLevel,
} from './gamification';
import { Card, Person } from './types';

/** `n` cards in one status (ids `<kind>-<i>`). */
function cardsIn(kind: Parameters<typeof cardInLifeV3>[0], n: number, extra: Partial<Card> = {}): Card[] {
  return Array.from({ length: n }, (_, i) => cardInLifeV3(kind, { id: `${kind}-${i}`, ...extra }));
}

function person(partial: Partial<Person> = {}): Person {
  return {
    xp: 0,
    streak: 0,
    bestStreak: 0,
    freezes: 0,
    freezeUsedDays: [],
    lastStudyDay: null,
    goalReviews: 20,
    goalNew: 10,
    dayDone: { dayKey: '2024-01-01', reviews: 0, neww: 0, checks: 0, newByDeck: {} },
    fastAnswers: 0,
    achievements: {},
    ...partial,
  };
}

function ctx(partial: Partial<AchievementContext> = {}): AchievementContext {
  return {
    person: person(),
    cards: [],
    sessions: [],
    masteredCount: 0,
    fastAnswers: 0,
    ...partial,
  };
}

describe('xpForLevel / levelInfo', () => {
  test('cumulative XP curve (220 + 50k per step)', () => {
    expect(xpForLevel(1)).toBe(0);
    expect(xpForLevel(2)).toBe(270);
    expect(xpForLevel(3)).toBe(590);
    expect(xpForLevel(4)).toBe(960);
  });

  test('levelInfo at a level floor', () => {
    const info = levelInfo(270);
    expect(info.level).toBe(2);
    expect(info.name).toBe('Apprentice');
    expect(info.into).toBe(0);
    expect(info.toNext).toBe(320);
    expect(info.pct).toBe(0);
  });

  test('levelInfo mid-level', () => {
    const info = levelInfo(300);
    expect(info.level).toBe(2);
    expect(info.into).toBe(30);
    expect(info.pct).toBe(9); // round(30/320*100)
  });

  test('name clamps past the last level name', () => {
    const info = levelInfo(xpForLevel(40));
    expect(info.level).toBe(40);
    expect(info.name).toBe('Luminary');
  });
});

describe('sessionXpItems / sessionXpTotal', () => {
  test('cards + correct + streak + run bonuses', () => {
    const counts = { again: 1, hard: 0, good: 3, easy: 1 };
    const items = sessionXpItems(counts, 5, 5, 3);
    expect(items.map((i) => i.xp)).toEqual([10, 8, 10, 8]); // 5*2, 4*2, streak, run
    expect(sessionXpTotal(items)).toBe(36);
  });

  test('no streak bonus at streak 0, no run bonus below 5', () => {
    const counts = { again: 0, hard: 0, good: 2, easy: 0 };
    const items = sessionXpItems(counts, 2, 4, 0);
    expect(items).toHaveLength(2); // cards + correct only
    expect(sessionXpTotal(items)).toBe(8); // 2*2 + 2*2
  });

  // W5-5a: every count uses plural() — "1 card", and a thousands comma like every other count.
  test('the labels say "1 card" / "5 cards" and format big numbers', () => {
    const one = sessionXpItems({ again: 0, hard: 0, good: 1, easy: 0 }, 1, 1, 1);
    expect(one.map((i) => i.label)).toEqual(['1 card reviewed', '1 correct', 'Daily streak · day 1']);
    const many = sessionXpItems({ again: 0, hard: 0, good: 1200, easy: 0 }, 1200, 1200, 1500);
    expect(many.map((i) => i.label)).toEqual(['1,200 cards reviewed', '1,200 correct', 'Daily streak · day 1,500', '1,200 in a row']);
  });
});

describe('achievements', () => {
  test('newlyUnlocked returns satisfied-but-unrecorded defs', () => {
    const unlocked = newlyUnlocked(ctx({ sessions: [{} as never], masteredCount: 0 }));
    expect(unlocked.map((d) => d.id)).toContain('first-steps');
  });

  test('an already-recorded achievement is not re-unlocked', () => {
    const unlocked = newlyUnlocked(
      ctx({ sessions: [{} as never], person: person({ achievements: { 'first-steps': 1 } }) }),
    );
    expect(unlocked.map((d) => d.id)).not.toContain('first-steps');
  });

  test('achievementStatuses clamps progress to the goal', () => {
    // W3-1: the mastered count comes from the cards (250 mastered cards), not from a number the caller passes.
    const statuses = achievementStatuses(ctx({ cards: cardsIn('mastered', 250) }));
    const centurion = statuses.find((s) => s.def.id === 'centurion')!;
    expect(centurion.prog).toBe(100); // min(goal 100, 250)
    expect(centurion.unlocked).toBe(false);
  });
});

describe('the mastery rule: Mastery achievements count isMastered cards only (W3-1)', () => {
  const status = (cards: Card[], id: string) => achievementStatuses(ctx({ cards })).find((s) => s.def.id === id)!;

  test('2,000 Known cards do not unlock Scholar (or Centurion)', () => {
    const known = cardsIn('known', 2000);
    expect(countMastered(known)).toBe(0);
    expect(status(known, 'scholar').prog).toBe(0);
    const ids = newlyUnlocked(ctx({ cards: known })).map((d) => d.id);
    expect(ids).not.toContain('scholar');
    expect(ids).not.toContain('centurion');
  });

  test('a Known card that was studied to a long interval is still not mastered', () => {
    // reps 9, interval 34 days: the old formula (reps > 0, graduated, ≥ 21 days) counted it.
    const knownAfterStudy = cardsIn('mastered', 600, { knownAt: 1 });
    expect(countMastered(knownAfterStudy)).toBe(0);
    expect(newlyUnlocked(ctx({ cards: knownAfterStudy })).map((d) => d.id)).not.toContain('scholar');
  });

  test('500 mastered cards unlock Scholar; learning, review and new cards do not count', () => {
    const cards = [
      ...cardsIn('mastered', 500),
      ...cardsIn('review', 30),
      ...cardsIn('learning', 30),
      ...cardsIn('new', 30),
      ...cardsIn('notStarted', 30),
    ];
    expect(countMastered(cards)).toBe(500);
    expect(newlyUnlocked(ctx({ cards })).map((d) => d.id)).toEqual(expect.arrayContaining(['centurion', 'scholar']));
    expect(status(cards, 'scholar')).toMatchObject({ prog: 500 });
  });

  test('a masteredCount the caller passes is ignored: the count always comes from the cards', () => {
    const known = cardsIn('known', 10);
    expect(status(known, 'centurion').prog).toBe(0);
    const statuses = achievementStatuses(ctx({ cards: known, masteredCount: 5000 }));
    expect(statuses.find((s) => s.def.id === 'centurion')!.prog).toBe(0);
    expect(newlyUnlocked(ctx({ cards: known, masteredCount: 5000 })).map((d) => d.id)).not.toContain('centurion');
  });

  test('countMastered: graduated with an interval of 21 days or more, and not Known', () => {
    const at21 = cardInLifeV3('mastered', { id: 'a', intervalDays: 21 });
    const at20 = cardInLifeV3('mastered', { id: 'b', intervalDays: 20 });
    const inLearning = cardInLifeV3('mastered', { id: 'c', stepIndex: 0 });
    const checked = cardInLifeV3('mastered', { id: 'd', knownAt: null, knownCheckedAt: 1 });
    expect(countMastered([at21, at20, inLearning, checked])).toBe(2);
    expect(countMastered([])).toBe(0);
  });
});

describe('completionTier', () => {
  test('tiers by accuracy', () => {
    expect(completionTier(95)[0]).toBe('Brilliant session.');
    expect(completionTier(75)[0]).toBe('Strong recall today.');
    expect(completionTier(40)[0]).toBe('Good, honest work.');
  });
});

describe('levelInfo.pct never reads a full 100% below the boundary (L19)', () => {
  test('XP one short of the next level reads 99%, not a rounded-up 100%', () => {
    // Level 2 begins at 270 XP; 269 is one short — under Math.round it read 100%.
    const info = levelInfo(269);
    expect(info.level).toBe(1);
    expect(info.pct).toBe(99);
  });

  test('the very start of a level reads 0%', () => {
    expect(levelInfo(0).pct).toBe(0);
  });
});

describe('level names (W4-6, spec §8.8)', () => {
  /** The German pack's names (spec §9.4), written out: the pack file comes with wave 5. */
  const GERMAN_LEVEL_NAMES = [
    'Novice',
    'Apprentice',
    'Student',
    'Reader',
    'Scribe',
    'Linguist',
    'Wordsmith',
    'Scholar',
    'Sage',
    'Polyglot',
    'Lexicographer',
    'Luminary',
  ];

  test('the 12 generic names are neutral, exactly spec §8.8', () => {
    expect([...LEVEL_NAMES]).toEqual([
      'Novice',
      'Apprentice',
      'Student',
      'Reader',
      'Scribe',
      'Keeper',
      'Maker',
      'Scholar',
      'Sage',
      'Mentor',
      'Master',
      'Luminary',
    ]);
    for (const old of ['Linguist', 'Wordsmith', 'Polyglot', 'Lexicographer']) expect(LEVEL_NAMES).not.toContain(old);
  });

  test('levelInfo names each level with the generic names by default', () => {
    expect(levelInfo(xpForLevel(6)).name).toBe('Keeper');
    expect(levelInfo(xpForLevel(7)).name).toBe('Maker');
    expect(levelInfo(xpForLevel(10)).name).toBe('Mentor');
    expect(levelInfo(xpForLevel(11)).name).toBe('Master');
    expect(levelInfo(xpForLevel(12)).name).toBe('Luminary');
  });

  test('a pack override replaces the names: the German build restores the originals', () => {
    const names = levelNames(GERMAN_LEVEL_NAMES);
    expect(levelInfo(xpForLevel(6), names).name).toBe('Linguist');
    expect(levelInfo(xpForLevel(7), names).name).toBe('Wordsmith');
    expect(levelInfo(xpForLevel(10), names).name).toBe('Polyglot');
    expect(levelInfo(xpForLevel(11), names).name).toBe('Lexicographer');
    // The numbers never change with the names.
    expect({ ...levelInfo(1000, names), name: '' }).toEqual({ ...levelInfo(1000), name: '' });
  });

  test('the generic pack has no override: the generic names', () => {
    expect(genericPack.levelNames).toBeUndefined();
    expect(levelNames(genericPack.levelNames)).toBe(LEVEL_NAMES);
  });

  test('a short or broken override keeps the generic name of each missing level', () => {
    const names = levelNames(['Beginner', '', '  ', 7, null, 'Sixth']);
    expect(names).toHaveLength(12);
    expect(names.slice(0, 6)).toEqual(['Beginner', 'Apprentice', 'Student', 'Reader', 'Scribe', 'Sixth']);
    expect(names[11]).toBe('Luminary');
    expect(levelNames([])).toBe(LEVEL_NAMES);
    expect(levelNames(null)).toBe(LEVEL_NAMES);
    expect(levelNames(undefined)).toBe(LEVEL_NAMES);
  });

  test('a pack may name more than 12 levels', () => {
    const names = levelNames([...GERMAN_LEVEL_NAMES, 'Legend']);
    expect(names).toHaveLength(13);
    expect(levelInfo(xpForLevel(13), names).name).toBe('Legend');
    expect(levelInfo(xpForLevel(40), names).name).toBe('Legend');
  });

  test('levelName clamps: past the end the last name, below 1 the first', () => {
    expect(levelName(8)).toBe('Scholar');
    expect(levelName(40)).toBe('Luminary');
    expect(levelName(0)).toBe('Novice');
    expect(levelName(Number.NaN)).toBe('Novice');
    expect(levelName(3, [])).toBe('Student');
  });
});
