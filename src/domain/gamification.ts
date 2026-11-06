/**
 * XP, levels, and achievements — the revived habit engine (plan C1/C2).
 * XP itemization mirrors screen-complete.jsx exactly: cards ×2, correct ×2,
 * streak bonus +10, run bonus +8 (runs of 5+).
 *
 * The mastery rule (W3-1, spec §1.2): the Mastery achievements count cards
 * with `isMastered` (src/domain/life.ts) — graduated, interval ≥ 21 days and
 * NOT Known. A Known card is one you SAID you know; the app has not tested it
 * over time. So marking 2,000 cards "I know it" unlocks no Mastery achievement.
 * The count is derived HERE from the cards, so every caller (the session
 * payout and the Progress screen) uses the same rule.
 *
 * Level names (W4-6, spec §8.8): the generic names are neutral (Keeper,
 * Maker, Mentor, Master instead of the language-era Linguist, Wordsmith,
 * Polyglot, Lexicographer). A content pack may override them
 * (`levelNames(pack.levelNames)`); this file stays pure and never reads the
 * pack itself, so the caller passes the names.
 */
import { isMastered, type LifeCard } from './life';
import { plural } from './text';
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
  // Every count says its unit with plural() ("1 card", "1,000 cards").
  const items: XpItem[] = [
    { label: `${plural(total, 'card')} reviewed`, xp: total * 2 },
    { label: `${correct.toLocaleString('en-US')} correct`, xp: correct * 2 },
  ];
  if (streakDays > 0) items.push({ label: `Daily streak · day ${streakDays.toLocaleString('en-US')}`, xp: STREAK_BONUS });
  if (bestRun >= RUN_BONUS_MIN) items.push({ label: `${bestRun.toLocaleString('en-US')} in a row`, xp: RUN_BONUS });
  return items;
}

export function sessionXpTotal(items: XpItem[]): number {
  return items.reduce((s, i) => s + i.xp, 0);
}

/* --------------------------------------------------------------- levels */

/**
 * The 12 level names of the generic app (spec §8.8, §7 #47). They are
 * NEUTRAL: Maranki is for anything you want to remember, so a level never
 * says "Linguist" or "Polyglot". A content pack may replace them
 * (`ContentPack.levelNames`, spec §9.4): the German build restores the
 * language names. Level 12 and every level above it use the last name.
 */
export const LEVEL_NAMES: readonly string[] = Object.freeze([
  'Novice', // level 1
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

/**
 * The level names to use: a pack's `levelNames` over the generic names,
 * one by one. A pack name that is missing, not text or blank keeps the
 * generic name of that level, so a short or broken list can never leave a
 * level without a name.
 *
 *   levelNames()                         → LEVEL_NAMES
 *   levelNames(['Beginner'])             → ['Beginner', 'Apprentice', … 'Luminary']
 *   levelNames(['', 'Second'])           → ['Novice', 'Second', 'Student', …]
 */
export function levelNames(override?: readonly unknown[] | null): readonly string[] {
  if (!Array.isArray(override) || override.length === 0) return LEVEL_NAMES;
  const out = LEVEL_NAMES.map((generic, i) => {
    const name = override[i];
    return typeof name === 'string' && name.trim() !== '' ? name.trim() : generic;
  });
  // A pack may name more than 12 levels: the extra names are used too.
  for (let i = LEVEL_NAMES.length; i < override.length; i++) {
    const name = override[i];
    if (typeof name !== 'string' || name.trim() === '') break;
    out.push(name.trim());
  }
  return out;
}

/**
 * The name of a level (1 = the first name). Levels past the end of the
 * list keep the last name; a level below 1 gets the first.
 *
 *   levelName(8)  → 'Scholar'
 *   levelName(40) → 'Luminary'
 *   levelName(6, levelNames(germanPack.levelNames)) → 'Linguist'
 */
export function levelName(level: number, names: readonly string[] = LEVEL_NAMES): string {
  const list = names.length > 0 ? names : LEVEL_NAMES;
  const at = Number.isFinite(level) ? Math.floor(level) - 1 : 0;
  return list[Math.min(Math.max(0, at), list.length - 1)];
}

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

/**
 * The level of `xp` XP. `names` are the level names to use (default the
 * generic ones); a screen passes `levelNames(activePack.levelNames)`, so the
 * German build shows its own names.
 *
 *   levelInfo(300) → { level: 2, name: 'Apprentice', into: 30, toNext: 290, pct: 9 }
 */
export function levelInfo(xp: number, names: readonly string[] = LEVEL_NAMES): LevelInfo {
  let level = 1;
  while (xpForLevel(level + 1) <= xp) level += 1;
  const floor = xpForLevel(level);
  const ceil = xpForLevel(level + 1);
  const into = xp - floor;
  const span = ceil - floor;
  return {
    level,
    name: levelName(level, names),
    into,
    toNext: ceil - xp,
    // Floor (capped at 99) so the bar never reads a full 100% while the next
    // level is still unearned — it fills only on the level-up itself (L19).
    pct: Math.min(99, Math.floor((into / span) * 100)),
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
  progress: (ctx: ResolvedContext) => number;
  /** Some unlocks also pay out a streak freeze (mock: Quick draw). */
  grantsFreeze?: boolean;
}

export interface AchievementContext {
  person: Person;
  /** Every card of the library. The Mastery goals count the mastered ones (`countMastered`). */
  cards: Card[];
  sessions: SessionRecord[];
  /**
   * Deprecated and NOT read (W3-1). The Mastery goals always count `cards`
   * with `isMastered`, so a caller can never count Known cards by mistake.
   * Kept optional so the callers written before the mastery rule still
   * compile; it goes away with the other wave-3 aliases (W5-3).
   */
  masteredCount?: number;
  fastAnswers: number;
}

/**
 * The context the achievement goals read: `ctx` with `masteredCount`
 * computed from its cards (the caller's own value is ignored, see above).
 */
export interface ResolvedContext extends AchievementContext {
  masteredCount: number;
}

/**
 * How many cards are Mastered (`isMastered`: graduated, interval ≥ 21 days,
 * not Known). One pass over the cards.
 *
 *   countMastered([masteredCard, knownCard, newCard]) → 1
 */
export function countMastered(cards: readonly LifeCard[]): number {
  let n = 0;
  for (const card of cards) if (isMastered(card)) n += 1;
  return n;
}

/** `ctx` with the mastered count computed once (the goals read it twice). */
function resolve(ctx: AchievementContext): ResolvedContext {
  return { ...ctx, masteredCount: countMastered(ctx.cards) };
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
];

export interface AchievementStatus {
  def: AchievementDef;
  unlocked: boolean;
  unlockedAt: number | null;
  prog: number;
}

export function achievementStatuses(input: AchievementContext): AchievementStatus[] {
  const ctx = resolve(input);
  return ACHIEVEMENT_DEFS.map((def) => {
    const unlockedAt = ctx.person.achievements[def.id] ?? null;
    const prog = Math.min(def.goal, def.progress(ctx));
    return { def, unlocked: unlockedAt !== null, unlockedAt, prog };
  });
}

/** Returns defs newly satisfied but not yet recorded on the person. */
export function newlyUnlocked(input: AchievementContext): AchievementDef[] {
  const ctx = resolve(input);
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
