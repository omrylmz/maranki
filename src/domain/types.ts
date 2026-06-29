/**
 * Core domain model. Shapes follow WIRING.md §4 ("data contracts"):
 * cards carry full SRS fields; deck/collection counts are DERIVED from cards
 * (single source of truth — the redesign's "trustworthy numbers" thesis).
 */

export type Rating = 'again' | 'hard' | 'good' | 'easy';

export type CefrLevel = 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2';

export type Lang = 'de' | 'es' | 'fr';

export type WordType =
  | 'noun'
  | 'verb'
  | 'adjective'
  | 'adverb'
  | 'phrase'
  | 'preposition'
  | 'pronoun'
  | 'conjunction';

/** Lifecycle: new → learning → review (graduated) → mastered (interval ≥ 21d). */
export type CardState = 'new' | 'learning' | 'review' | 'mastered' | 'due';

export interface Card {
  id: string;
  deckId: string;
  /** Full display form, e.g. "die Stunde". */
  word: string;
  /** Gender/article de-emphasised on the flashcard, e.g. "die". */
  article: string | null;
  /** The bare word, e.g. "Stunde". */
  base: string;
  /** Translation. */
  tr: string;
  ipa?: string;
  /** Example sentence in the target language. */
  ex?: string;
  /** Example translation. */
  exTr?: string;
  /** CEFR level, or null when the source carries no such metadata (e.g. an import). */
  level: CefrLevel | null;
  /** Part of speech, or null when the source carries no such metadata (e.g. an import). */
  type: WordType | null;
  lang: Lang;
  tags?: string[];
  fav?: boolean;
  flagged?: boolean;
  suspended?: boolean;
  /** Epoch ms until which the card is buried (skipped), or null. */
  buriedUntil?: number | null;

  /* --- SRS state --- */
  /** SM-2 ease factor; starts at settings.startingEase (2.5). */
  ease: number;
  /** Current graduated interval in days; 0 while still in learning. */
  intervalDays: number;
  /** Index into learning steps; null once graduated. */
  stepIndex: number | null;
  reps: number;
  lapses: number;
  /** Next review due, epoch ms. */
  due: number;
  createdAt: number;
  lastReviewedAt: number | null;
}

export interface Deck {
  id: string;
  name: string;
  /** Flag emoji — data, not iconography (see design README). */
  flag: string;
  lang: string;
  level: CefrLevel | null;
  desc?: string;
  builtin: boolean;
  active: boolean;
  createdAt: number;
}

export type CollectionQuery = 'hardest' | 'favorites' | 'young' | 'flagged';

/** A collection is a saved smart filter — a live query, not a folder. */
export interface Collection {
  id: string;
  name: string;
  icon: string;
  desc: string;
  query: CollectionQuery;
}

export interface SrsSettings {
  /** Anki-style learning steps, in minutes. */
  learningStepsMin: number[];
  graduatingIntervalDays: number;
  easyIntervalDays: number;
  startingEase: number;
  easyBonus: number;
  hardMultiplier: number;
  lapseMultiplier: number;
  intervalModifier: number;
  maxIntervalDays: number;
  dailyNewLimit: number;
  dailyReviewLimit: number;
}

export const DEFAULT_SRS: SrsSettings = {
  learningStepsMin: [1, 10],
  graduatingIntervalDays: 1,
  easyIntervalDays: 4,
  startingEase: 2.5,
  easyBonus: 1.3,
  hardMultiplier: 1.2,
  lapseMultiplier: 0.5,
  intervalModifier: 1.0,
  maxIntervalDays: 36500,
  dailyNewLimit: 10,
  dailyReviewLimit: 200,
};

export interface ReviewLogEntry {
  id: string;
  cardId: string;
  rating: Rating;
  atMs: number;
  /** Snapshot of the card's SRS fields before this review — backs real undo (A1). */
  prev: Pick<
    Card,
    'ease' | 'intervalDays' | 'stepIndex' | 'reps' | 'lapses' | 'due' | 'lastReviewedAt'
  >;
  /** Was this the card's first-ever review (consumed a "new" slot)? */
  wasNew: boolean;
}

export type SessionKind = 'scheduled' | 'ahead' | 'cram' | 'hardest' | 'deck' | 'collection';

export interface SessionRecord {
  id: string;
  dayKey: string;
  atMs: number;
  kind: SessionKind;
  counts: Record<Rating, number>;
  total: number;
  bestRun: number;
  xp: number;
}

export interface DayDone {
  dayKey: string;
  reviews: number;
  neww: number;
}

export interface Person {
  xp: number;
  streak: number;
  bestStreak: number;
  freezes: number;
  /** Day keys on which a freeze auto-bridged a missed day (for the 14-day strip). */
  freezeUsedDays: string[];
  lastStudyDay: string | null;
  goalReviews: number;
  goalNew: number;
  dayDone: DayDone;
  /** Lifetime count of fast answers (reveal → rate under 3s), for Quick draw. */
  fastAnswers: number;
  /** Achievement id → unlocked-at epoch ms. */
  achievements: Record<string, number>;
}

export interface AppSettings {
  srs: SrsSettings;
  ttsEnabled: boolean;
  /** Speak the word automatically when the answer is revealed. */
  autoPlayAudio: boolean;
  /** Prompt pronunciation practice on hard cards (C4). */
  pronunciationPrompt: boolean;
  hapticsEnabled: boolean;
  reminderEnabled: boolean;
  reminderTime: string;
  /** Session behavior prefs (study drill-in). */
  sessionLimit: number;
  studyMode: 'flash' | 'type' | 'mc' | 'mix';
  hintsEnabled: boolean;
  retryMissed: boolean;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  srs: DEFAULT_SRS,
  ttsEnabled: true,
  autoPlayAudio: false,
  pronunciationPrompt: true,
  hapticsEnabled: true,
  reminderEnabled: true,
  reminderTime: '21:00',
  sessionLimit: 50,
  studyMode: 'flash',
  hintsEnabled: true,
  retryMissed: true,
};

export interface DataState {
  cards: Card[];
  decks: Deck[];
  collections: Collection[];
  person: Person;
  sessions: SessionRecord[];
  reviewLog: ReviewLogEntry[];
  settings: AppSettings;
  onboarded: boolean;
}

/* ------------------------------------------------------------- helpers */

export const MASTERED_INTERVAL_DAYS = 21;

export function lifecycleState(card: Card): Exclude<CardState, 'due'> {
  if (card.reps === 0) return 'new';
  if (card.stepIndex !== null) return 'learning';
  if (card.intervalDays >= MASTERED_INTERVAL_DAYS) return 'mastered';
  return 'review';
}

/** Display state used by badges/rows: "due" wins over review/mastered/learning. */
export function displayState(card: Card, now: number): CardState {
  const lc = lifecycleState(card);
  if (lc !== 'new' && card.due <= now && !card.suspended) return 'due';
  return lc;
}

export function isDue(card: Card, now: number): boolean {
  return (
    card.reps > 0 &&
    card.due <= now &&
    !card.suspended &&
    (!card.buriedUntil || card.buriedUntil <= now)
  );
}

export function dayKeyOf(ms: number): string {
  const d = new Date(ms);
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export function addDays(dayKey: string, delta: number): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  const date = new Date(y, m - 1, d + delta);
  return dayKeyOf(date.getTime());
}

export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
