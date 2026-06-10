/**
 * XP, levels, and achievements — the revived habit engine (plan C1/C2).
 * XP itemization mirrors screen-complete.jsx exactly: cards ×2, correct ×2,
 * streak bonus +10, run bonus +8 (runs of 5+).
 */
import { Card, Person, Rating, SessionRecord } from './types';

/* ------------------------------------------------------------------ XP */

export interface XpItem {
  label: string;
  xp: number;
}

export const STREAK_BONUS = 10;
export const RUN_BONUS = 8;
export const RUN_BONUS_MIN = 5;

export function sessionXpItems(
  counts: Record<Rating, number>,
  total: number,
  bestRun: number,
  streakDays: number,
): XpItem[] {
  const correct = total - counts.again;
  const items: XpItem[] = [
    { label: `${total} ${total === 1 ? 'card' : 'cards'} reviewed`, xp: total * 2 },
    { label: `${correct} correct`, xp: correct * 2 },
  ];
  if (streakDays > 0) items.push({ label: `Daily streak · day ${streakDays}`, xp: STREAK_BONUS });
  if (bestRun >= RUN_BONUS_MIN) items.push({ label: `${bestRun} in a row`, xp: RUN_BONUS });
  return items;
}

export function sessionXpTotal(items: XpItem[]): number {
  return items.reduce((s, i) => s + i.xp, 0);
}

/* --------------------------------------------------------------- levels */

export const LEVEL_NAMES = [
  'Novice', // level 1
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

/** Cumulative XP required to REACH `level` (level 1 = 0). */
export function xpForLevel(level: number): number {
  // step from level k to k+1 costs 220 + 50k
  let total = 0;
  for (let k = 1; k < level; k++) total += 220 + 50 * k;
  return total;
}

export interface LevelInfo {
  level: number;
  name: string;
  /** XP earned within the current level. */
  into: number;
  /** XP still needed for the next level. */
  toNext: number;
  /** 0–100 progress through the current level. */
  pct: number;
}

export function levelInfo(xp: number): LevelInfo {
  let level = 1;
  while (xpForLevel(level + 1) <= xp) level += 1;
  const floor = xpForLevel(level);
  const ceil = xpForLevel(level + 1);
  const into = xp - floor;
  const span = ceil - floor;
  return {
    level,
    name: LEVEL_NAMES[Math.min(level - 1, LEVEL_NAMES.length - 1)],
    into,
    toNext: ceil - xp,
    pct: Math.round((into / span) * 100),
  };
}

/* --------------------------------------------------------- achievements */

export interface AchievementDef {
  id: string;
  name: string;
  desc: string;
  icon: string;
  cat: 'Study' | 'Streak' | 'Mastery' | 'Speed';
  goal: number;
  progress: (ctx: AchievementContext) => number;
  /** Some unlocks also pay out a streak freeze (mock: Quick draw). */
  grantsFreeze?: boolean;
}

export interface AchievementContext {
  person: Person;
  cards: Card[];
  sessions: SessionRecord[];
  masteredCount: number;
  languagesStudied: number;
  fastAnswers: number;
}

export const ACHIEVEMENT_DEFS: AchievementDef[] = [
  {
    id: 'first-steps',
    name: 'First steps',
    desc: 'Complete your first session',
    icon: 'footsteps',
    cat: 'Study',
    goal: 1,
    progress: (c) => c.sessions.length,
  },
  {
    id: 'week-warrior',
    name: 'Week warrior',
    desc: 'Hold a 7-day streak',
    icon: 'flame',
    cat: 'Streak',
    goal: 7,
    progress: (c) => Math.max(c.person.streak, c.person.bestStreak),
  },
  {
    id: 'centurion',
    name: 'Centurion',
    desc: 'Master 100 cards',
    icon: 'ribbon',
    cat: 'Mastery',
    goal: 100,
    progress: (c) => c.masteredCount,
  },
  {
    id: 'quick-draw',
    name: 'Quick draw',
    desc: '50 fast answers',
    icon: 'flash',
    cat: 'Speed',
    goal: 50,
    progress: (c) => c.fastAnswers,
    grantsFreeze: true,
  },
  {
    id: 'fortnight',
    name: 'Fortnight',
    desc: 'Hold a 14-day streak',
    icon: 'calendar',
    cat: 'Streak',
    goal: 14,
    progress: (c) => Math.max(c.person.streak, c.person.bestStreak),
  },
  {
    id: 'scholar',
    name: 'Scholar',
    desc: 'Master 500 cards',
    icon: 'school',
    cat: 'Mastery',
    goal: 500,
    progress: (c) => c.masteredCount,
  },
  {
    id: 'marathon',
    name: 'Marathon',
    desc: 'Hold a 30-day streak',
    icon: 'trophy',
    cat: 'Streak',
    goal: 30,
    progress: (c) => Math.max(c.person.streak, c.person.bestStreak),
  },
  {
    id: 'polyglot',
    name: 'Polyglot',
    desc: 'Study three languages',
    icon: 'globe',
    cat: 'Study',
    goal: 3,
    progress: (c) => c.languagesStudied,
  },
];

export interface AchievementStatus {
  def: AchievementDef;
  unlocked: boolean;
  unlockedAt: number | null;
  prog: number;
}

export function achievementStatuses(ctx: AchievementContext): AchievementStatus[] {
  return ACHIEVEMENT_DEFS.map((def) => {
    const unlockedAt = ctx.person.achievements[def.id] ?? null;
    const prog = Math.min(def.goal, def.progress(ctx));
    return { def, unlocked: unlockedAt !== null, unlockedAt, prog };
  });
}

/** Returns defs newly satisfied but not yet recorded on the person. */
export function newlyUnlocked(ctx: AchievementContext): AchievementDef[] {
  return ACHIEVEMENT_DEFS.filter(
    (def) => !(def.id in ctx.person.achievements) && def.progress(ctx) >= def.goal,
  );
}

export const MAX_FREEZES = 3;

/** Session-complete coaching copy, tiered by accuracy (screen-complete.jsx). */
export function completionTier(accuracyPct: number): [string, string] {
  if (accuracyPct >= 90) return ['Brilliant session.', 'Your recall is razor-sharp today.'];
  if (accuracyPct >= 70) return ['Strong recall today.', 'Your retention is climbing.'];
  return [
    'Good, honest work.',
    'The misses will come back soon — that’s the system working.',
  ];
}
