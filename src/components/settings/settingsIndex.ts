/**
 * The Settings index (spec §8.6, unit W4-5) — PURE: no React, no clock.
 *
 * What lives here:
 *   - SETTINGS_INDEX: every setting row of every Settings page, with the
 *     page it lives on and its search keywords (spec §8.6 "Search keywords
 *     per row (exact)"). The search box on the Settings hub uses it, so a
 *     search finds a row on ANY page ("session limit" → Session size, on
 *     Study & limits) — the old search only knew the hub's own groups.
 *   - `searchSettings(query)`: the rows that match.
 *   - The summary lines of the hub rows ("10 new · 200 reviews a day ·
 *     sessions of 30 · Flashcards").
 *   - The value LADDERS of the Study & limits steppers: a stepper walks a
 *     list of useful values (10, 20, … 100, 120, 150 …) instead of +1 steps,
 *     and the stored value is always one of the stops (`ladderWith`), so the
 *     screen never shows a number that is not the setting.
 *   - The words of the danger zone (Reset preferences, Erase everything),
 *     what the Erase sheet lists, and which of its buttons work while a
 *     backup is being saved (`eraseSheetControls`).
 *   - The hub's footer line ("Maranki 3.0.0", `appFooterLine`), and the
 *     answers that the tour (also "Replay the tour") selects first: the
 *     Time step's pace (`tourPace`) and the reminder time
 *     (`tourReminderTime`).
 *   - `withHubBelow(state)`: the Settings stack with the hub put under a
 *     drill-in that was opened on its own (settings/_layout.tsx uses it).
 *
 * How a search matches: the query and the row words are folded (case and
 * accents do not matter, `foldText`) and cut into words. Every query word
 * must match ONE row word: the row word starts with the query word
 * ("notif" → "notification"), or the query word starts with a row word of 4
 * letters or more ("reminders" → "reminder"). The row words are its
 * keywords and the words of its title.
 *
 *   searchSettings('session limit') → [Session size]
 *   searchSettings('limit')         → [New cards per day, Reviews per day, Session size]
 */
import { foldText, plural } from '../../domain/text';
import { type AppSettings, DEFAULT_APP_SETTINGS, NO_REVIEW_LIMIT } from '../../domain/types';
import { type OnboardingValues, type PaceId, paceOf } from './onboardingDiff';

/* ---------------------------------------------------------------- pages */

/** The Settings pages: the hub and its four drill-ins (spec §2.2). */
export type SettingsPage = 'index' | 'study' | 'reminders' | 'data' | 'algorithm';

/** Each page's title (the drill-in's header and the search result's "where"). */
export const PAGE_TITLE: Readonly<Record<SettingsPage, string>> = {
  index: 'Settings',
  study: 'Study & limits',
  reminders: 'Reminders',
  data: 'Your data',
  algorithm: 'Algorithm',
};

/**
 * Each drill-in's route. They are real routes of the Settings stack, so
 * Android's hardware back closes a drill-in instead of leaving the tab (E15).
 */
export const PAGE_ROUTE: Readonly<Record<Exclude<SettingsPage, 'index'>, string>> = {
  study: '/settings/study',
  reminders: '/settings/reminders',
  data: '/settings/data',
  algorithm: '/settings/algorithm',
};

/** The route name of the hub inside the Settings stack (the file `settings/index.tsx`). */
export const HUB_ROUTE = 'index';

/**
 * The Settings stack with the hub put UNDER it, or null when the hub is
 * already the first page (review round 2).
 *
 * WHY: another screen can open a drill-in directly — Today's "Want a daily
 * reminder?" opens `/(tabs)/settings/reminders?enable=1`. When the Settings
 * stack was not mounted yet (the tabs are lazy), expo-router builds the stack
 * from the LAST route of the link only: `[reminders]`, without the hub. The
 * layout's `anchor` helps only a cold deep link; an in-app push loads it only
 * with `{ withAnchor: true }`. Then "back" leaves the tab, the tab keeps
 * `[reminders]`, and the hub can never be reached again. The Settings layout
 * (settings/_layout.tsx) calls this on every focus and state change and
 * resets the stack to the result, so it does not depend on the caller.
 *
 * The routes that are there stay EXACTLY the same objects (same `key`, same
 * params), so the open page is not mounted again and a `?enable=1` request
 * does not run twice. The new hub route has no key: the router gives it one.
 *
 *   withHubBelow({ index: 0, routes: [reminders] }) → { index: 1, routes: [{ name: 'index' }, reminders] }
 *   withHubBelow({ index: 1, routes: [index, reminders] }) → null
 */
export function withHubBelow<S extends { index: number; routes: readonly { name: string }[] }>(
  state: S | null | undefined,
): (Omit<S, 'index' | 'routes'> & { index: number; routes: (S['routes'][number] | { name: typeof HUB_ROUTE })[] }) | null {
  if (!state || state.routes.length === 0 || state.routes[0].name === HUB_ROUTE) return null;
  return { ...state, index: state.index + 1, routes: [{ name: HUB_ROUTE }, ...state.routes] };
}

/** The two navigation calls the repair needs (a Settings page's `navigation` fits). */
export interface HubRepairNavigation {
  /** The Settings stack's state (the page's navigator). */
  getState(): { index: number; routes: readonly { name: string }[] } | undefined;
  dispatch(action: { type: 'RESET'; payload: object }): void;
}

/**
 * Put the hub under the pages when it is missing (`withHubBelow`); otherwise
 * do nothing. `{ type: 'RESET', payload }` is exactly what React Navigation's
 * `CommonActions.reset(payload)` makes: the router keeps every route that has
 * a key and gives the new hub route one.
 */
export function keepHubBelow(navigation: HubRepairNavigation): void {
  const next = withHubBelow(navigation.getState());
  if (next) navigation.dispatch({ type: 'RESET', payload: next });
}

/**
 * The Settings stack's `screenListeners` (settings/_layout.tsx): the repair
 * runs on every focus and on every state change of a page, so the hub is
 * put under a lone drill-in as soon as the stack exists.
 *
 *   <Stack screenListeners={hubRepairListeners}>
 */
export function hubRepairListeners({ navigation }: { navigation: HubRepairNavigation }) {
  return {
    focus: () => keepHubBelow(navigation),
    state: () => keepHubBelow(navigation),
  };
}

/* ---------------------------------------------------------------- index */

export type SettingsId =
  | 'appearance'
  | 'newPerDay'
  | 'reviewsPerDay'
  | 'reviewsGoal'
  | 'newGoal'
  | 'sessionSize'
  | 'defaultMode'
  | 'hints'
  | 'retryMissed'
  | 'spaceSiblings'
  | 'knownChecks'
  | 'reminders'
  | 'readAloud'
  | 'autoReadAloud'
  | 'haptics'
  | 'freezes'
  | 'import'
  | 'exportBackup'
  | 'restore'
  | 'autoBackups'
  | 'backupImages'
  | 'history'
  | 'algorithm'
  | 'help'
  | 'tour'
  | 'resetPreferences'
  | 'erase';

export interface SettingsEntry {
  id: SettingsId;
  /** The row title, exactly as the page shows it. */
  title: string;
  /** The page the row lives on. */
  page: SettingsPage;
  /** The search keywords (spec §8.6). The title words are searched too. */
  keywords: readonly string[];
}

/** Every setting row, in page order (spec §8.6). */
export const SETTINGS_INDEX: readonly SettingsEntry[] = [
  { id: 'appearance', title: 'Appearance', page: 'index', keywords: ['appearance', 'theme', 'dark', 'light', 'paper', 'evening', 'system'] },
  { id: 'newPerDay', title: 'New cards per day', page: 'study', keywords: ['new', 'limit', 'daily'] },
  { id: 'reviewsPerDay', title: 'Reviews per day', page: 'study', keywords: ['review', 'limit'] },
  { id: 'reviewsGoal', title: 'Reviews goal', page: 'study', keywords: ['goal'] },
  { id: 'newGoal', title: 'New cards goal', page: 'study', keywords: ['goal'] },
  { id: 'sessionSize', title: 'Session size', page: 'study', keywords: ['session', 'size', 'limit', 'length'] },
  { id: 'defaultMode', title: 'Default mode', page: 'study', keywords: ['mode', 'typing', 'quiz', 'mixed', 'flashcards'] },
  { id: 'hints', title: 'Hints', page: 'study', keywords: ['hint'] },
  { id: 'retryMissed', title: 'Retry missed cards', page: 'study', keywords: ['retry', 'missed'] },
  { id: 'spaceSiblings', title: 'Space out both directions', page: 'study', keywords: ['sibling', 'direction', 'reverse'] },
  { id: 'knownChecks', title: 'Known-card checks per day', page: 'study', keywords: ['known', 'check'] },
  { id: 'reminders', title: 'Reminders', page: 'reminders', keywords: ['reminder', 'notification', 'time'] },
  { id: 'readAloud', title: 'Read-aloud button', page: 'index', keywords: ['read', 'aloud', 'speak', 'voice', 'tts'] },
  { id: 'autoReadAloud', title: 'Speak the question automatically', page: 'index', keywords: ['read', 'aloud', 'speak', 'voice', 'tts'] },
  { id: 'haptics', title: 'Haptics', page: 'index', keywords: ['haptic', 'vibration'] },
  { id: 'freezes', title: 'Streak freezes', page: 'index', keywords: ['freeze', 'streak'] },
  { id: 'import', title: 'Import', page: 'data', keywords: ['import'] },
  { id: 'exportBackup', title: 'Export a backup', page: 'data', keywords: ['export', 'backup', 'share'] },
  { id: 'restore', title: 'Restore a backup', page: 'data', keywords: ['restore'] },
  { id: 'autoBackups', title: 'Automatic backups', page: 'data', keywords: ['backup', 'automatic', 'weekly'] },
  { id: 'backupImages', title: 'Include images in backups', page: 'data', keywords: ['backup', 'images'] },
  { id: 'history', title: 'Export study history (CSV)', page: 'data', keywords: ['history', 'csv'] },
  { id: 'algorithm', title: 'Algorithm (SM-2 settings)', page: 'algorithm', keywords: ['algorithm', 'ease', 'interval', 'steps'] },
  { id: 'help', title: 'Help & FAQ', page: 'index', keywords: ['help', 'faq'] },
  { id: 'tour', title: 'Replay the tour', page: 'index', keywords: ['tour', 'onboarding'] },
  { id: 'resetPreferences', title: 'Reset preferences', page: 'index', keywords: ['reset', 'erase', 'delete'] },
  { id: 'erase', title: 'Erase everything', page: 'index', keywords: ['reset', 'erase', 'delete'] },
];

/** The folded words of a text: 'Export study history (CSV)' → ['export', 'study', 'history', 'csv']. */
export function searchWords(text: string): string[] {
  return foldText(text)
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== '');
}

/** Does one query word match one row word? See the top of the file. */
function wordMatches(rowWord: string, queryWord: string): boolean {
  return rowWord.startsWith(queryWord) || (rowWord.length >= 4 && queryWord.startsWith(rowWord));
}

/** True when every word of `query` matches a keyword or a title word of `entry`. An empty query matches everything. */
export function matchesSetting(entry: SettingsEntry, query: string): boolean {
  const queryWords = searchWords(query);
  if (queryWords.length === 0) return true;
  const rowWords = [...entry.keywords.flatMap(searchWords), ...searchWords(entry.title)];
  return queryWords.every((q) => rowWords.some((w) => wordMatches(w, q)));
}

/** The rows that match `query`, in page order. An empty query gives every row. */
export function searchSettings(query: string, index: readonly SettingsEntry[] = SETTINGS_INDEX): SettingsEntry[] {
  return index.filter((entry) => matchesSetting(entry, query));
}

/** The message under the search box when nothing matches. */
export function noSettingsMatch(query: string): string {
  return `No settings match "${query.trim()}".`;
}

/* ------------------------------------------------------------ the words */

/** The study modes as words (never the stored ids `mc` / `type`, spec §7 #34). */
export const MODE_LABEL: Readonly<Record<AppSettings['studyMode'], string>> = {
  flash: 'Flashcards',
  type: 'Typing',
  mc: 'Quiz',
  mix: 'Mixed',
};

/** The order of the mode control (spec §8.6: Flashcards | Typing | Quiz | Mixed). */
export const MODE_ORDER: readonly AppSettings['studyMode'][] = ['flash', 'type', 'mc', 'mix'];

/** The word of a stored mode; an unknown value reads as Flashcards (the session falls back to it too). */
export function modeLabel(mode: unknown): string {
  return typeof mode === 'string' && mode in MODE_LABEL ? MODE_LABEL[mode as AppSettings['studyMode']] : MODE_LABEL.flash;
}

/**
 * The hub's "Study & limits" line (spec §8.6):
 *   "10 new · 200 reviews a day · sessions of 30 · Flashcards"
 * "No limit" values read "no review limit" / "no session limit".
 */
export function studySummary(settings: Pick<AppSettings, 'srs' | 'sessionLimit' | 'studyMode'>): string {
  const { dailyNewLimit, dailyReviewLimit } = settings.srs;
  const reviews =
    dailyReviewLimit >= NO_REVIEW_LIMIT ? 'no review limit' : `${plural(dailyReviewLimit, 'review')} a day`;
  const sessions =
    settings.sessionLimit > 0 ? `sessions of ${settings.sessionLimit.toLocaleString('en-US')}` : 'no session limit';
  return [`${dailyNewLimit.toLocaleString('en-US')} new`, reviews, sessions, modeLabel(settings.studyMode)].join(' · ');
}

/** The hub's "Streak freezes" line (spec §8.6): "2 available · earn one every 7 days". */
export function freezesLine(freezes: number): string {
  return `${Math.max(0, Math.floor(freezes)).toLocaleString('en-US')} available · earn one every 7 days`;
}

/**
 * What a screen reader says for the freeze count on the hub: "1 streak
 * freeze", "2 streak freezes" — with plural(), never "1 streak freezes"
 * (spec §8.11, review round 1).
 */
export function freezesLabel(freezes: number): string {
  return plural(Math.max(0, Math.floor(freezes)), 'streak freeze');
}

/* ------------------------------------------------------------- ladders */

/**
 * The stops of each Study & limits stepper. The ranges are spec §8.6:
 *   New cards per day 0–999 · Reviews per day 10–9,999 or "No limit"
 *   (stored as 99,999) · Session size 5–200 or "No limit" (stored as 0) ·
 *   goals 0 = Off · Known-card checks per day 0 = Off.
 */
export const LADDERS = {
  newPerDay: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20, 25, 30, 40, 50, 60, 70, 80, 90, 100, 120, 150, 200, 250, 300, 400, 500, 750, 999],
  reviewsPerDay: [
    10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 120, 150, 200, 250, 300, 400, 500, 750, 1000, 1500, 2000, 3000, 5000,
    7500, 9999, NO_REVIEW_LIMIT,
  ],
  sessionSize: [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 90, 100, 120, 150, 200, 0],
  reviewsGoal: [0, 5, 10, 15, 20, 25, 30, 40, 50, 60, 75, 100, 150, 200, 300, 500],
  newGoal: [0, 1, 2, 3, 4, 5, 10, 15, 20, 25, 30, 40, 50, 75, 100],
  knownChecks: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20, 25, 30, 40, 50],
} as const;

/** How a stop is ordered: 0 = "No limit" for the session size, so it is the biggest. */
export function sessionRank(value: number): number {
  return value === 0 ? Infinity : value;
}

/**
 * The stops with `current` added in its place when it is not one of them
 * (old or hand-edited data, e.g. a session size of 33). So the stepper shows
 * the TRUE setting, and one step moves to the next real stop.
 *
 *   ladderWith([10, 20, 30], 25) → [10, 20, 25, 30]
 *   ladderWith([5, 10, 0], 7, sessionRank) → [5, 7, 10, 0]
 */
export function ladderWith(stops: readonly number[], current: number, rank: (v: number) => number = (v) => v): number[] {
  if (!Number.isFinite(current) || stops.includes(current)) return [...stops];
  const out = [...stops, current];
  out.sort((a, b) => rank(a) - rank(b));
  return out;
}

/** "No limit" / "Off" words for the stepper values. */
export const stepWords = {
  reviews: (v: number) => (v >= NO_REVIEW_LIMIT ? 'No limit' : v.toLocaleString('en-US')),
  session: (v: number) => (v === 0 ? 'No limit' : v.toLocaleString('en-US')),
  offWhenZero: (v: number) => (v === 0 ? 'Off' : v.toLocaleString('en-US')),
  plain: (v: number) => v.toLocaleString('en-US'),
};

/* ------------------------------------------------------- danger zone */

/**
 * "Reset preferences" (spec §8.6): settings to defaults, data untouched.
 *
 * `body` names EVERYTHING the reset changes (wave 5, tested in wave 5b R3):
 * reducer.ts `resetPreferences` puts the whole settings object back to its
 * defaults (only the date of the last automatic backup and the one-time
 * reminder offer stay), and the Settings hub also puts the daily goals back.
 * An older, shorter text listed only some of it, so a tuned algorithm, the
 * hints or the backup options went back to their defaults without a word.
 * The theme (Appearance) is stored on its own and is not changed.
 * settingsIndex.test.ts checks that every settings key has its word here.
 */
export const RESET_COPY = {
  title: 'Reset preferences?',
  body:
    'Limits, goals, session and study options, the algorithm, reminders, audio, haptics and backup options ' +
    'all go back to their defaults. Your decks, cards, progress, backups and appearance are not changed.',
  confirm: 'Reset preferences',
  cancel: 'Cancel',
  done: 'Preferences reset — your study data is untouched.',
} as const;

/* ------------------------------------------------------------ footer */

/** The app's name when the build does not say it (expo-constants gives no config, e.g. in a test). */
export const DEFAULT_APP_NAME = 'Maranki';

/**
 * The quiet line at the bottom of the Settings hub (spec §8.6, wave 5b L9):
 * the app's HUMAN name and its version, for example "Maranki 3.0.0" or
 * "Maranki German 3.0.0". The name comes from the build config
 * (`Constants.expoConfig.name`, set per variant in app.config.ts), never
 * from the internal variant id ("generic" is not a word a learner knows).
 *
 *   appFooterLine({ name: 'Maranki German', version: '3.0.0' }) → 'Maranki German 3.0.0'
 *   appFooterLine(null)                                         → 'Maranki'
 */
export function appFooterLine(config: { name?: unknown; version?: unknown } | null | undefined): string {
  const name = typeof config?.name === 'string' && config.name.trim() !== '' ? config.name.trim() : DEFAULT_APP_NAME;
  const version = typeof config?.version === 'string' ? config.version.trim() : '';
  return version !== '' ? `${name} ${version}` : name;
}

/* ------------------------------------------------ the tour's first answers */

/** The Time step's answer of a first run whose values are no answer (spec §8.9: the middle one). */
export const FIRST_RUN_PACE: PaceId = 'ten';

/** What the tour's Time step selects first, and whether it offers "Keep my pace". */
export interface TourPaceStart {
  selected: PaceId | 'own';
  /** True: the step shows a fourth answer, "Keep my pace — about {n} min: …" (`ownPaceLabel`). */
  offerOwn: boolean;
}

/**
 * The answer the tour's Time step selects first (spec §8.9, wave 5b L6):
 *   - a REPLAY: the learner's own values — their answer, or "Keep my pace"
 *     when the values are no answer (a replay writes only what changes);
 *   - a FIRST RUN: their answer when the values are one, else the middle
 *     answer ("10 new a day", FIRST_RUN_PACE), and NO "Keep my pace".
 * WHY: the values of a first run were never chosen by the learner. A new
 * install's seed IS the middle answer (seed.ts DEFAULT_PACE, wave 5d), but
 * values from an older build may be no answer: the wave 5c seed (6 new,
 * goals 20 / 6) is none of the answers "5 / 10 / 20 new a day". Without this
 * rule such a first run would show a fourth answer, "Keep my pace — about
 * 10 min", already selected. The same idea as the reminder time below
 * (`tourReminderTime`).
 *
 *   tourPace({ dailyNewLimit: 10, goalReviews: 30, goalNew: 10 }, true)  → { selected: 'ten', offerOwn: false }  (the seed)
 *   tourPace({ dailyNewLimit: 6, goalReviews: 20, goalNew: 6 }, false)   → { selected: 'ten', offerOwn: false }
 *   tourPace({ dailyNewLimit: 6, goalReviews: 20, goalNew: 6 }, true)    → { selected: 'own', offerOwn: true }
 */
export function tourPace(
  values: Pick<OnboardingValues, 'dailyNewLimit' | 'goalReviews' | 'goalNew'>,
  replay: boolean,
): TourPaceStart {
  const pace = paceOf(values);
  if (replay) return { selected: pace ?? 'own', offerOwn: pace === null };
  return { selected: pace ?? FIRST_RUN_PACE, offerOwn: false };
}

/**
 * The time the tour's Reminder step offers first (spec §8.9 "Remind me at
 * 8:00 PM", wave 5b L7):
 *   - a REPLAY, or reminders that are ON: the learner's own time (a replay
 *     is pre-filled with the current values, spec §8.9);
 *   - a FIRST RUN with reminders off: the default time, 8:00 PM ('20:00').
 * WHY: the stored time of a first run is not a choice of the learner.
 * (Data from the old app had the old default, '21:00', and its reminder
 * never worked. The migration now moves that time to '20:00' as well —
 * src/store/migrate.ts, wave 5b review round 1 — so Today's one-time offer
 * and Settings › Reminders say 8:00 PM too. This rule covers any other time
 * a first run may start from.)
 *
 *   tourReminderTime({ reminderEnabled: false, reminderTime: '21:00' }, false) → '20:00'
 *   tourReminderTime({ reminderEnabled: false, reminderTime: '21:00' }, true)  → '21:00'
 */
export function tourReminderTime(
  values: { reminderEnabled: boolean; reminderTime: string },
  replay: boolean,
): string {
  if (replay || values.reminderEnabled) return values.reminderTime;
  return DEFAULT_APP_SETTINGS.reminderTime;
}

/** The Erase sheet (spec §8.6, §7 #13). */
export const ERASE_COPY = {
  title: 'Erase everything?',
  intro: 'This is a factory reset. It permanently deletes:',
  exportFirst: 'Export a backup first',
  exporting: 'Saving a backup…',
  saved: 'Backup saved ✓',
  /**
   * The 1-second hold button: exactly "Erase everything" (spec §8.6). The
   * HoldButton itself tells a screen reader to hold ("Press and hold for
   * one second.", its accessibility hint), so the label needs no "Hold to".
   */
  hold: 'Erase everything',
  /**
   * The line right under the hold button, for everyone who can SEE it: the
   * accessibility hint reaches only a screen reader, and a plain tap only
   * flickers (final review 2026-11: the button looked broken).
   */
  holdNote: 'Press and hold for 1 second to erase.',
  cancel: 'Keep my data',
  done: 'Everything was erased — welcome to a fresh start.',
  /** factoryReset ran, but its save did not commit (W2 hardening leftover). */
  notSaved: 'The erase was not saved — your phone may be out of storage. Maranki will try to save it again.',
} as const;

/** What the Erase sheet lists. */
export interface EraseFacts {
  decks: number;
  cards: number;
  sessions: number;
  streak: number;
  level: number;
}

/** The Erase sheet's list of what goes (counts with plural(): "1 deck", never "1 decks"). */
export function eraseConsequences(f: EraseFacts): string[] {
  return [
    `${plural(f.decks, 'deck')} and ${plural(f.cards, 'card')}`,
    `All study progress, the review history and ${plural(f.sessions, 'session')}`,
    f.streak > 0 ? `Your ${f.streak.toLocaleString('en-US')}-day streak and level ${f.level}` : `Your level ${f.level} and achievements`,
    'Every setting and reminder',
  ];
}

/** The Erase sheet's "Export a backup first": idle → busy → done (or failed). */
export type EraseExportState = 'idle' | 'busy' | 'done' | 'failed';

/** Which controls of the Erase sheet work now. */
export interface EraseSheetControls {
  /** The 1-second "Erase everything" hold is off. */
  holdDisabled: boolean;
  /** The sheet stays open (backdrop, Android back, "Keep my data" do nothing). */
  keepOpen: boolean;
}

/**
 * What the Erase sheet allows (spec §8.6: export → "Backup saved ✓" → then
 * the 1-second hold). Review round 2: while the backup is still being saved
 * ('busy'), the hold is OFF and the sheet stays open. Before, the hold worked
 * during the export: `factoryReset()` emptied the library (its save can
 * empty the review history while the backup is still reading it), the
 * sheet closed, and a failed backup was then reported inside a closed
 * sheet — nobody saw it.
 * After the export ('done' or 'failed') the hold works again: the learner
 * may still erase without a backup, now that they have seen the result.
 *
 *   eraseSheetControls('busy', false) → { holdDisabled: true, keepOpen: true }
 *   eraseSheetControls('failed', false) → { holdDisabled: false, keepOpen: false }
 */
export function eraseSheetControls(exportState: EraseExportState, erasing: boolean): EraseSheetControls {
  const saving = exportState === 'busy';
  return { holdDisabled: erasing || saving, keepOpen: saving };
}

/**
 * The snackbar after the hold: "erased" only when the save of the factory
 * reset committed (`actions.flush()` resolved `{ ok: true }`).
 */
export function eraseResultMessage(saved: { ok: boolean } | null | undefined): string {
  return saved?.ok === true ? ERASE_COPY.done : ERASE_COPY.notSaved;
}
