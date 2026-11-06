/**
 * First-run state — a schema-3 document (the v3 note model, spec §3.4).
 *
 * Maranki opens as a BLANK SLATE: buildSeedState() returns no decks, no card
 * types, no notes, no cards and zeroed stats. There is no curated corpus — the
 * learner creates or imports every deck themselves. Only a zeroed Person, the
 * pinned built-in lists and the three old saved-filter Collections are
 * provisioned, so the app is meaningful from the very first launch.
 *
 * The seed is also the base of `mergeDefaults` (src/store/migrate.ts): a
 * stored document that misses a person field gets the seed's value.
 *
 * The daily pace of a new install is the tour's MIDDLE answer
 * (`DEFAULT_PACE`, wave 5d): 10 new cards a day and goals of 30 reviews and
 * 10 new cards. "Reset preferences" goes back to the seed too (reducer.ts
 * `resetPreferences` and the Settings hub's setGoals), so the tour, a new
 * install and a reset always agree.
 */
import {
  AppSettings,
  Collection,
  CURRENT_SCHEMA,
  DataState,
  dayKeyOf,
  DEFAULT_APP_SETTINGS,
  ListPref,
  MIN_READER,
  Person,
} from './types';

/**
 * The pinned built-in lists of a new install (spec §4.7). They are exactly
 * the lists that the v2 → v3 migration gives the three seed collections below
 * (migrateV3.ts: hard → 'builtin:hard', fav → 'builtin:favorites', daily →
 * 'builtin:recent'), so a new install and an updated one show the same lists.
 */
const SEED_LIST_IDS = ['builtin:hard', 'builtin:favorites', 'builtin:recent'] as const;

/**
 * The daily pace of a new install and of "Reset preferences": the MIDDLE
 * answer of the tour's "How much time a day?" (spec §8.9, wave 5d). This is
 * the ONE place for these numbers: the tour's middle answer
 * (onboardingDiff.ts `PACES`) is built from it.
 *
 *   dailyNewLimit → settings.srs.dailyNewLimit (a daily LIMIT)
 *   goalReviews   → person.goalReviews         (a GOAL for the Today bars)
 *   goalNew       → person.goalNew             (a GOAL; the same number as the limit)
 *
 * 10 new cards a day with about 3 reviews for each new card: 10 + 30 = 40
 * cards, about 15 min by `minutesFor` (23 seconds a card).
 *
 * WHY 10 and not fewer (wave 5d, a product decision): wave 5c lowered the
 * pace to 6 new cards a day, only so that the tour's label "10 min" matched
 * `minutesFor`. That silently slowed down every new learner. Now the pace is
 * the familiar 10 new a day again, and the LABELS are honest instead: each
 * answer shows the minutes that `minutesFor` computes for its cards
 * ("10 new a day · about 15 min", onboardingDiff.ts `paceLabel`).
 *
 * An existing install keeps its own values: no migration ever writes these
 * numbers. DEFAULT_SRS.dailyNewLimit (src/domain/types.ts) is only the
 * REPAIR value: what a damaged or missing stored limit is read as
 * (schedule.ts `remaining`, migrate.ts `mergeDefaults`).
 */
export const DEFAULT_PACE = { dailyNewLimit: 10, goalReviews: 30, goalNew: 10 } as const;

export function buildSeedState(now: number): DataState {
  const today = dayKeyOf(now);

  // A brand-new learner: nothing studied, nothing added. Decks arrive only when
  // the learner creates or imports one — never seeded here.
  const person: Person = {
    xp: 0,
    streak: 0,
    bestStreak: 0,
    freezes: 0,
    freezeUsedDays: [],
    lastStudyDay: '',
    // The tour's middle answer (DEFAULT_PACE): goals for the Today bars, never limits.
    goalReviews: DEFAULT_PACE.goalReviews,
    goalNew: DEFAULT_PACE.goalNew,
    dayDone: { dayKey: today, reviews: 0, neww: 0, checks: 0, newByDeck: {} },
    fastAnswers: 0,
    achievements: {},
  };

  // Deprecated (v2 → v4): the old saved filters. The old screens still read
  // them until wave 4 replaces them with the code-defined built-in lists.
  const collections: Collection[] = [
    { id: 'hard', name: 'Hardest cards', icon: 'flame', desc: 'Lowest ease across decks', query: 'hardest' },
    { id: 'fav', name: 'Favorites', icon: 'heart', desc: 'Cards you starred', query: 'favorites' },
    { id: 'daily', name: 'Daily practice', icon: 'today', desc: 'Young cards · interval 0–7d', query: 'young' },
  ];

  const listPrefs: Record<string, ListPref> = {};
  SEED_LIST_IDS.forEach((id, order) => {
    listPrefs[id] = { pinned: true, hidden: false, order };
  });

  // A deep copy: a change to the seed must never change the shared defaults.
  const settings: AppSettings = JSON.parse(JSON.stringify(DEFAULT_APP_SETTINGS));
  // The new-card limit of the tour's middle answer (DEFAULT_PACE). Every other setting is the default.
  settings.srs.dailyNewLimit = DEFAULT_PACE.dailyNewLimit;

  return {
    // A new document is written in this build's schema (spec §3.1).
    schemaVersion: CURRENT_SCHEMA,
    minReaderVersion: MIN_READER,
    noteTypes: [],
    notes: [],
    cards: [],
    decks: [],
    lists: [],
    listPrefs,
    person,
    sessions: [],
    reviewLog: [],
    manualLog: [],
    settings,
    onboarded: false,
    inProgressSession: null,
    pack: null,
    collections,
  };
}
