/**
 * Baseline characterization tests for XP, levels and achievements.
 * Locks in current behavior; the pct-rounding and freeze-economy fixes
 * arrive in a later phase and extend this file.
 */
import { describe, expect, test } from '@jest/globals';

import {
  AchievementContext,
  achievementStatuses,
  completionTier,
  levelInfo,
  newlyUnlocked,
  sessionXpItems,
  sessionXpTotal,
  xpForLevel,
} from './gamification';
import { Person } from './types';

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
    dayDone: { dayKey: '2024-01-01', reviews: 0, neww: 0 },
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
    languagesStudied: 0,
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
    const statuses = achievementStatuses(ctx({ masteredCount: 250 }));
    const centurion = statuses.find((s) => s.def.id === 'centurion')!;
    expect(centurion.prog).toBe(100); // min(goal 100, 250)
    expect(centurion.unlocked).toBe(false);
  });
});

describe('completionTier', () => {
  test('tiers by accuracy', () => {
    expect(completionTier(95)[0]).toBe('Brilliant session.');
    expect(completionTier(75)[0]).toBe('Strong recall today.');
    expect(completionTier(40)[0]).toBe('Good, honest work.');
  });
});
