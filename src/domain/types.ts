/**
 * Core domain model. Since wave 3 (W3-1, spec §3.4) the LIVE data shape is
 * the v3 NOTE MODEL of ./model.ts: the text of a card lives in a NOTE, and a
 * card is one direction of that note. This file re-exports every v3 shape, so
 * `DataState`, `Card`, `Deck`, `Person`, `AppSettings` … mean the v3 shapes
 * everywhere in the app.
 *
 * What lives HERE, and not in model.ts (model.ts is types only):
 *   - the shapes that did not change from v2 to v3 (`Rating`, `Collection`,
 *     `SrsSettings`). model.ts imports them from here;
 *   - the runtime values: the schema version, the default settings, the daily
 *     limit ranges and the small date and status helpers;
 *   - the schema-2 shapes, renamed `…V2` (`CardV2`, `DeckV2`, `DataStateV2` …).
 *     Only the migration code reads them (src/store/migrate.ts, migrateV3.ts):
 *     an old document is read in its own shape, then turned into the v3 one.
 *     (The v2 test factories, src/test/factories.ts, build such old
 *     documents for the migration tests.) Since W5-3 no app code builds a
 *     v2 object: the v2 constructors of make.ts and the old import payload
 *     type are deleted.
 *
 * Deck and collection counts are DERIVED from cards, never stored (the
 * "trustworthy numbers" rule).
 *
 * Example:
 *   import { Card, DataState, CardV2 } from '../domain/types';
 *   const live: Card = state.cards[0];       // v3: noteId, ord, newPos …
 *   const old: CardV2 = v2Doc.cards[0];      // v2: front, back … (migration only)
 */
import type { AppSettings, Card, DataStateV3, LegacyCardV0 } from './model';

/* Every v3 shape (Note, NoteType, Card, Deck, Person, DayDone, AppSettings …). */
export type * from './model';

/** The live state of the app: the v3 note model (spec §3.4). */
export type DataState = DataStateV3;

export type Rating = 'again' | 'hard' | 'good' | 'easy';

/** Lifecycle: new → learning → review (graduated) → mastered (interval ≥ 21d). */
export type CardState = 'new' | 'learning' | 'review' | 'mastered' | 'due';

/* ------------------------------------------------------- schema version */

/**
 * The schema version this build WRITES (spec §3.1). Schema 0 = v2.0.x and the
 * German fork (`word`/`tr` cards); 1 = main@1333d48 (`front`/`back`, no
 * version field); 2 = waves 1–2 (version fields, `legacy` copies);
 * 3 = this build: the note model. Every stored shape change bumps it, and
 * src/store/migrate.ts gets one more step.
 */
export const CURRENT_SCHEMA = 3;
/**
 * The oldest app schema that can still READ what this build writes. Additive
 * changes keep it; removing a field or changing its meaning raises it.
 * Schema 3 removed `front`/`back` from cards, so a schema-2 build must not
 * read it: its own check finds `minReaderVersion` 3 above its schema 2 and
 * says "too new" (spec §3.1 rule 6) instead of reading cards without text.
 */
export const MIN_READER = 3;

/*
 * `LegacyCardV0` — the raw copy of a schema-0 card (v2.0.x / German fork),
 * `{word, article, base, tr, ipa?, ex?, exTr?, level, type, lang}` — comes
 * with the `export type *` above. It is defined ONCE, in model.ts, so the v2
 * and v3 cards carry the very same type. The v2 → v3 step lifts it into note
 * fields (Level, Type, Pronunciation …), so nothing the old app stored is lost.
 */

/** Raw copy of the schema-0 deck fields that have no slot in schema 2. */
export interface LegacyDeckV0 {
  flag?: string;
  lang?: string;
  level?: string | null;
}

export type CollectionQuery = 'hardest' | 'favorites' | 'young' | 'flagged';

/**
 * A collection is a saved smart filter — a live query, not a folder.
 * Deprecated (v2 → v4): the built-in lists of src/domain/lists.ts replace it.
 * It stays in the state until schema 4, because a stored field is removed
 * only in the "contract" release (spec §3.1). No screen shows it; only an
 * old collection id is mapped to its built-in list (sessionLogic.ts).
 */
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

/**
 * The allowed range of each daily limit (spec §8.6, "Study & limits"). The
 * review limit is never below 10: a limit of 0 used to hide every review
 * without telling the learner. 99,999 is how "No limit" is stored.
 */
export const LIMIT_RANGES = {
  dailyNewLimit: { min: 0, max: 999 },
  dailyReviewLimit: { min: 10, max: 99_999 },
} as const;

/** The stored value that means "No limit" for reviews (spec §8.6). */
export const NO_REVIEW_LIMIT = 99_999;
/** The highest real review limit a user can pick; anything above means "No limit". */
export const MAX_REAL_REVIEW_LIMIT = 9_999;

export type DailyLimits = Pick<SrsSettings, 'dailyNewLimit' | 'dailyReviewLimit'>;

/**
 * `patch` made safe: each limit is rounded to a whole number and moved into
 * its range. A value that is not a finite number is left out, so the current
 * limit stays. Example: `clampLimits({ dailyReviewLimit: 0 })` →
 * `{ dailyReviewLimit: 10 }`, and `clampLimits({ dailyReviewLimit: 12_000 })` →
 * `{ dailyReviewLimit: 99_999 }` ("No limit").
 */
export function clampLimits(patch: Partial<DailyLimits>): Partial<DailyLimits> {
  const out: Partial<DailyLimits> = {};
  for (const key of ['dailyNewLimit', 'dailyReviewLimit'] as const) {
    const value = patch[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const { min, max } = LIMIT_RANGES[key];
    const clamped = Math.min(max, Math.max(min, Math.round(value)));
    // Reviews: 10–9,999 are real limits. Anything above means "No limit",
    // which is always stored as exactly 99,999 (spec §8.6).
    out[key] =
      key === 'dailyReviewLimit' && clamped > MAX_REAL_REVIEW_LIMIT ? NO_REVIEW_LIMIT : clamped;
  }
  return out;
}

/**
 * The default settings of the v3 app (spec §3.4). A stored document that
 * misses a key gets the value here (`mergeDefaults` in src/store/migrate.ts).
 * The seven keys that schema 3 added get the same values as the v2 → v3
 * migration (spec §3.5), so a new install and an updated one agree.
 */
export const DEFAULT_APP_SETTINGS: AppSettings = {
  srs: DEFAULT_SRS,
  readAloudEnabled: true,
  autoReadAloud: false,
  hapticsEnabled: true,
  reminderEnabled: false,
  // Spec §3.4: 'HH:MM', default 20:00 (the same as reminderPlan.ts DEFAULT_REMINDER_TIME).
  reminderTime: '20:00',
  reminderSkipStudied: true,
  sessionLimit: 50,
  studyMode: 'flash',
  hintsEnabled: true,
  retryMissed: true,
  spaceSiblings: true,
  knownChecksPerDay: 5,
  autoBackup: true,
  lastAutoBackupAt: null,
  backupImages: true,
  reminderOfferSeen: false,
};

/* ------------------------------------------------------------- helpers */

export const MASTERED_INTERVAL_DAYS = 21;

/**
 * The card keys the status helpers below read. Both a v3 `Card` and a v2
 * `CardV2` fit (a v2 card has no `knownAt`: it is never Known).
 */
export type StatusCard = Pick<Card, 'reps' | 'stepIndex' | 'intervalDays' | 'due' | 'suspended' | 'buriedUntil' | 'knownAt'>;

/**
 * The old 4-state lifecycle (new / learning / review / mastered) of a v2
 * card. No screen uses it since wave 4: every screen shows the v3 status
 * (with Not started and Known), `life()` in src/domain/life.ts. It stays for
 * the v2 test factories (src/test/factories.test.ts checks their cards with
 * it) and goes with the v2 shapes at schema 4.
 */
export function lifecycleState(card: Pick<StatusCard, 'reps' | 'stepIndex' | 'intervalDays'>): Exclude<CardState, 'due'> {
  if (card.reps === 0) return 'new';
  if (card.stepIndex !== null) return 'learning';
  if (card.intervalDays >= MASTERED_INTERVAL_DAYS) return 'mastered';
  return 'review';
}

/** Display state used by badges/rows: "due" wins over review/mastered/learning. */
export function displayState(card: StatusCard, now: number): CardState {
  const lc = lifecycleState(card);
  // A buried (or suspended) card isn't studiable today, so it must not read as
  // "due" even when overdue — same gate as isDue (L13). A Known card is never
  // due either (it is not studied, spec §1.2).
  const buried = !!card.buriedUntil && card.buriedUntil > now;
  if (lc !== 'new' && card.knownAt == null && card.due <= now && !card.suspended && !buried) return 'due';
  return lc;
}

/**
 * True when a studied card's review time has come and it can be studied now:
 * not suspended, not buried, and not Known (a Known card is never due — the
 * same rule as `isDueNow` in src/domain/life.ts).
 */
export function isDue(card: StatusCard, now: number): boolean {
  return (
    card.reps > 0 &&
    card.knownAt == null &&
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

/* ================================================== schema 2 (migration only) */

/*
 * The shapes of a schema-2 document (waves 1–2, releases v2.1.x–v2.2.x),
 * exactly as they were. Only the migration code uses them: `v0toV2` and
 * `v1toV2` write them, the v2 `sanitize` / `mergeDefaults` repair them, and
 * `v2toV3` (src/store/migrateV3.ts) turns them into the v3 shapes above.
 * Nothing else may read or write them.
 */

/** A schema-2 card: it holds its own text (`front`, `back` …). */
export interface CardV2 {
  id: string;
  deckId: string;
  /** The prompt shown on the front face. */
  front: string;
  /** The answer shown on the back face. */
  back: string;
  /** Optional example sentence. */
  example?: string;
  /** Optional freeform notes. */
  notes?: string;
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
  /** Only on cards migrated from schema 0: the old card's language fields, unchanged. */
  legacy?: LegacyCardV0;
}

/** A schema-2 deck. */
export interface DeckV2 {
  id: string;
  name: string;
  /** Emoji shown on the deck tile — data, not iconography (see design README). */
  icon: string;
  desc?: string;
  builtin: boolean;
  active: boolean;
  createdAt: number;
  /** Only on decks migrated from schema 0: the old flag, language and level. */
  legacy?: LegacyDeckV0;
}

/** A schema-2 undo entry: `wasNew` instead of the v3 `bucket`, no `seq`, no `deckId`. */
export interface ReviewLogEntryV2 {
  id: string;
  cardId: string;
  rating: Rating;
  atMs: number;
  /** Snapshot of the card's SRS fields before this review — backs real undo (A1). */
  prev: Pick<CardV2, 'ease' | 'intervalDays' | 'stepIndex' | 'reps' | 'lapses' | 'due' | 'lastReviewedAt'>;
  /** Was this the card's first-ever review (consumed a "new" slot)? */
  wasNew: boolean;
}

/** The schema-2 session kinds (v3 adds 'practice'). */
export type SessionKindV2 = 'scheduled' | 'ahead' | 'cram' | 'hardest' | 'deck' | 'collection';

/** A schema-2 finished session (v3 adds the optional `mode` and `scopeLabel`). */
export interface SessionRecordV2 {
  id: string;
  dayKey: string;
  atMs: number;
  kind: SessionKindV2;
  counts: Record<Rating, number>;
  total: number;
  bestRun: number;
  xp: number;
}

/** A schema-2 day tally (v3 adds `checks` and `newByDeck`). */
export interface DayDoneV2 {
  dayKey: string;
  reviews: number;
  neww: number;
}

/** A schema-2 in-flight session marker (M5). Same fields as v3, with the v2 kinds. */
export interface InProgressSessionV2 {
  kind: SessionKindV2;
  label: string;
  counts: Record<Rating, number>;
  total: number;
  bestRun: number;
  durationSec: number;
  fastAnswers: number;
  /** The calendar day the session's reviews belong to. Optional: older markers lack it. */
  studyDay?: string;
}

/** The schema-2 learner progress (the v2 day tally). */
export interface PersonV2 {
  xp: number;
  streak: number;
  bestStreak: number;
  freezes: number;
  /** Day keys on which a freeze auto-bridged a missed day (for the 14-day strip). */
  freezeUsedDays: string[];
  lastStudyDay: string | null;
  goalReviews: number;
  goalNew: number;
  dayDone: DayDoneV2;
  /** Lifetime count of fast answers (reveal → rate under 3s), for Quick draw. */
  fastAnswers: number;
  /** Achievement id → unlocked-at epoch ms. */
  achievements: Record<string, number>;
}

/** The schema-2 settings (v3 adds seven keys, spec §3.5). */
export interface AppSettingsV2 {
  srs: SrsSettings;
  readAloudEnabled: boolean;
  autoReadAloud: boolean;
  hapticsEnabled: boolean;
  reminderEnabled: boolean;
  reminderTime: string;
  sessionLimit: number;
  studyMode: 'flash' | 'type' | 'mc' | 'mix';
  hintsEnabled: boolean;
  retryMissed: boolean;
}

/** The default settings of schema 2: the v3 defaults without the seven keys schema 3 added. */
export const DEFAULT_APP_SETTINGS_V2: AppSettingsV2 = {
  srs: DEFAULT_SRS,
  readAloudEnabled: DEFAULT_APP_SETTINGS.readAloudEnabled,
  autoReadAloud: DEFAULT_APP_SETTINGS.autoReadAloud,
  hapticsEnabled: DEFAULT_APP_SETTINGS.hapticsEnabled,
  reminderEnabled: DEFAULT_APP_SETTINGS.reminderEnabled,
  reminderTime: DEFAULT_APP_SETTINGS.reminderTime,
  sessionLimit: DEFAULT_APP_SETTINGS.sessionLimit,
  studyMode: DEFAULT_APP_SETTINGS.studyMode,
  hintsEnabled: DEFAULT_APP_SETTINGS.hintsEnabled,
  retryMissed: DEFAULT_APP_SETTINGS.retryMissed,
};

/** A whole schema-2 document (what `migrate()` returned in waves 1–2). */
export interface DataStateV2 {
  /** The schema this document follows (2 when a wave-1/2 build wrote it). */
  schemaVersion: number;
  /** The oldest schema that may read this document. */
  minReaderVersion: number;
  cards: CardV2[];
  decks: DeckV2[];
  collections: Collection[];
  person: PersonV2;
  sessions: SessionRecordV2[];
  reviewLog: ReviewLogEntryV2[];
  settings: AppSettingsV2;
  onboarded: boolean;
  /** A session in flight, reconciled on next boot if the app was killed (M5). */
  inProgressSession: InProgressSessionV2 | null;
}
