/**
 * The onboarding's choices and what they write (spec §8.9, §7 #36, unit
 * W4-5) — PURE: no React, no store.
 *
 * The tour (`/onboarding`) has four steps: Welcome · Time · Reminder · First
 * cards. "Replay the tour" (`/onboarding?replay=1`) shows the same steps,
 * PRE-FILLED with the CURRENT values, and writes ONLY what the user changed
 * (step 4 is skipped). The old tour wrote its own defaults on every replay,
 * so "Replay the tour" quietly reset the learner's limits (spec §7 #36).
 *
 * The rule lives in `onboardingDiff(initial, chosen)`:
 *   initial = the values when the tour opened (`onboardingValues(state)`);
 *   chosen  = the values after the user's choices;
 *   result  = only the changed groups — `limits` (setLimits) and `goals`
 *             (setGoals, both goals at once, because setGoals takes both).
 *   An unchanged choice gives `{}`: nothing is written.
 *
 * The reminder step writes at the moment of the tap, not at the end, because
 * turning reminders ON needs the system permission prompt right then
 * (`enableReminders`, src/store/reminderSync.ts). `reminderChange(initial,
 * chosen)` says what that tap must do (nothing / turn on / new time / off).
 *
 * The Time step's answers are 5, 10 and 20 new cards a day, with about 3
 * reviews for each new card (wave 5d, a product decision). Each answer
 * shows the time its cards take with `minutesFor()` (the one time formula),
 * so it says the same time Today then shows (`paceLabel`):
 * "10 new a day · about 15 min". The step's title stays "How much time a
 * day?" (spec §8.9): the answers carry the real numbers.
 * The middle answer IS the pace of a new install and of "Reset
 * preferences": all three come from seed.ts `DEFAULT_PACE`, so a first run
 * already has an answer, and a reset never lands on a pace the tour does
 * not offer.
 *
 * "Not now" on the Reminder step also says what it writes
 * (`declineReminderPatch`): on a first run it keeps the time the step showed.
 *
 * Example (step 2, "Continue"):
 *   const diff = onboardingDiff(initial, applyPace(chosen, PACES[0].id));
 *   applyOnboardingDiff(diff, actions);   // { limits: { dailyNewLimit: 5 }, goals: { goalReviews: 15, goalNew: 5 } }
 */
import { minutesFor } from '../../domain/schedule';
import { DEFAULT_PACE } from '../../domain/seed';
import type { AppSettings, Person, SrsSettings } from '../../domain/types';

/* ------------------------------------------------------------- values */

/** The values the tour can change. */
export interface OnboardingValues {
  /** `settings.srs.dailyNewLimit` — the Time step's "N new". */
  dailyNewLimit: number;
  /** `person.goalReviews` — "about N reviews" (a goal for the Today bars; never a limit). */
  goalReviews: number;
  /** `person.goalNew`. */
  goalNew: number;
  reminderEnabled: boolean;
  /** 'HH:MM', 24 h. */
  reminderTime: string;
}

/** The values of the state now (the pre-fill of the tour). */
export function onboardingValues(state: {
  settings: Pick<AppSettings, 'reminderEnabled' | 'reminderTime'> & { srs: Pick<SrsSettings, 'dailyNewLimit'> };
  person: Pick<Person, 'goalReviews' | 'goalNew'>;
}): OnboardingValues {
  return {
    dailyNewLimit: state.settings.srs.dailyNewLimit,
    goalReviews: state.person.goalReviews,
    goalNew: state.person.goalNew,
    reminderEnabled: state.settings.reminderEnabled === true,
    reminderTime: state.settings.reminderTime,
  };
}

/* -------------------------------------------------------------- paces */

export type PaceId = 'five' | 'ten' | 'twenty';

/** One answer of "How much time a day?" (spec §8.9). */
export interface Pace {
  id: PaceId;
  /** The button text (`paceLabel`): "5 new a day · about 8 min". */
  label: string;
  /** What it writes: the new-card limit and the two goals (goalNew = the new cards). */
  dailyNewLimit: number;
  goalReviews: number;
  goalNew: number;
}

/**
 * A pace's button text: "{n} new a day · about {minutes} min".
 *
 * The minutes come from `minutesFor(new + reviews)`, the ONE time formula of
 * the app (spec §8.9: "Minutes use minutesFor() (one formula everywhere)"),
 * so the tour and Today always say the same time. The reviews are counted
 * in the minutes, but the text names only the new cards: that is the number
 * the learner chooses (the reviews a day follow from it).
 *
 *   paceLabel(5, 15)  → '5 new a day · about 8 min'
 *   paceLabel(10, 30) → '10 new a day · about 15 min'
 */
export function paceLabel(dailyNewLimit: number, goalReviews: number): string {
  const minutes = minutesFor(dailyNewLimit + goalReviews);
  return `${dailyNewLimit.toLocaleString('en-US')} new a day · about ${minutes.toLocaleString('en-US')} min`;
}

/** A pace from what it writes (the label is built from the same numbers). */
function pace(id: PaceId, dailyNewLimit: number, goalReviews: number): Pace {
  return { id, label: paceLabel(dailyNewLimit, goalReviews), dailyNewLimit, goalReviews, goalNew: dailyNewLimit };
}

/**
 * The three answers of "How much time a day?" (wave 5d, a product
 * decision): 5, 10 and 20 new cards a day, each with about 3 reviews for
 * every new card, because the reviews a day grow with the new cards a day.
 * By `minutesFor` (23 seconds a card) they take about 8, 15 and 31 minutes,
 * and each label says exactly that:
 *
 *   5 new  + 15 reviews = 20 cards → "5 new a day · about 8 min"
 *   10 new + 30 reviews = 40 cards → "10 new a day · about 15 min"
 *   20 new + 60 reviews = 80 cards → "20 new a day · about 31 min"
 *
 * WHY (wave 5d): wave 5c chose the cards so that the labels could say "5 /
 * 10 / 20 min" (3, 6 and 12 new a day). That silently slowed down every new
 * learner. Now the paces are the familiar ones, and the labels tell the
 * real time instead.
 *
 * The middle answer is read from seed.ts `DEFAULT_PACE`: the pace of a new
 * install and of "Reset preferences". One place for the numbers, so the
 * tour and the defaults cannot drift apart. The ids ('five', 'ten',
 * 'twenty') name the new cards a day.
 */
export const PACES: readonly Pace[] = [
  pace('five', 5, 15),
  pace('ten', DEFAULT_PACE.dailyNewLimit, DEFAULT_PACE.goalReviews),
  pace('twenty', 20, 60),
];

/** The pace these values are, or null when they are the learner's own (a replay after custom settings). */
export function paceOf(v: Pick<OnboardingValues, 'dailyNewLimit' | 'goalReviews' | 'goalNew'>): PaceId | null {
  const pace = PACES.find(
    (p) => p.dailyNewLimit === v.dailyNewLimit && p.goalReviews === v.goalReviews && p.goalNew === v.goalNew,
  );
  return pace ? pace.id : null;
}

/** The values with a pace chosen. */
export function applyPace(v: OnboardingValues, id: PaceId): OnboardingValues {
  const pace = PACES.find((p) => p.id === id);
  if (!pace) return v;
  return { ...v, dailyNewLimit: pace.dailyNewLimit, goalReviews: pace.goalReviews, goalNew: pace.goalNew };
}

/**
 * The extra answer of a REPLAY when the current values are no pace: keep
 * them. The minutes come from `minutesFor()` (the one time formula).
 *   "Keep my pace — about 9 min: 12 new, about 12 reviews"
 */
export function ownPaceLabel(v: Pick<OnboardingValues, 'dailyNewLimit' | 'goalReviews'>): string {
  const minutes = minutesFor(v.dailyNewLimit + v.goalReviews);
  return `Keep my pace — about ${minutes} min: ${v.dailyNewLimit.toLocaleString('en-US')} new, about ${v.goalReviews.toLocaleString('en-US')} reviews`;
}

/* --------------------------------------------------------------- diff */

/** What the tour must write. Each key is there only when it changed. */
export interface OnboardingDiff {
  limits?: { dailyNewLimit: number };
  goals?: { goalReviews: number; goalNew: number };
}

/** Only the changed values (see the top of the file). */
export function onboardingDiff(initial: OnboardingValues, chosen: OnboardingValues): OnboardingDiff {
  const diff: OnboardingDiff = {};
  if (chosen.dailyNewLimit !== initial.dailyNewLimit) diff.limits = { dailyNewLimit: chosen.dailyNewLimit };
  if (chosen.goalReviews !== initial.goalReviews || chosen.goalNew !== initial.goalNew) {
    diff.goals = { goalReviews: chosen.goalReviews, goalNew: chosen.goalNew };
  }
  return diff;
}

/** True when the diff writes nothing. */
export function isEmptyDiff(diff: OnboardingDiff): boolean {
  return diff.limits === undefined && diff.goals === undefined;
}

/** The two store actions a diff uses (`useData().actions` fits). */
export interface DiffActions {
  setLimits(patch: Partial<Pick<SrsSettings, 'dailyNewLimit' | 'dailyReviewLimit'>>): void;
  setGoals(goalReviews: number, goalNew: number): void;
}

/** Write a diff: setLimits for the limit, setGoals for the goals (a goal NEVER writes a limit). */
export function applyOnboardingDiff(diff: OnboardingDiff, actions: DiffActions): void {
  if (diff.limits) actions.setLimits({ dailyNewLimit: diff.limits.dailyNewLimit });
  if (diff.goals) actions.setGoals(diff.goals.goalReviews, diff.goals.goalNew);
}

/* ----------------------------------------------------------- reminder */

/**
 * What a tap on the Reminder step must do:
 *   'none'   — nothing changed (a replay that keeps the reminder as it is);
 *   'enable' — turn reminders on at `time` (the permission flow first);
 *   'time'   — reminders stay on, at a new `time`;
 *   'disable'— turn reminders off.
 */
export type ReminderChange =
  | { kind: 'none' }
  | { kind: 'enable'; time: string }
  | { kind: 'time'; time: string }
  | { kind: 'disable' };

export function reminderChange(
  initial: Pick<OnboardingValues, 'reminderEnabled' | 'reminderTime'>,
  chosen: Pick<OnboardingValues, 'reminderEnabled' | 'reminderTime'>,
): ReminderChange {
  if (chosen.reminderEnabled && !initial.reminderEnabled) return { kind: 'enable', time: chosen.reminderTime };
  if (!chosen.reminderEnabled && initial.reminderEnabled) return { kind: 'disable' };
  if (chosen.reminderEnabled && chosen.reminderTime !== initial.reminderTime) {
    return { kind: 'time', time: chosen.reminderTime };
  }
  return { kind: 'none' };
}

/**
 * What the Reminder step's quiet button writes ("Not now", or "Turn off
 * reminders" when they are on). null = nothing.
 *   - reminders are ON (a replay, or a first run after "Erase everything"
 *     with the reminder still on): turn them off → `{ reminderEnabled: false }`;
 *   - a FIRST RUN with reminders off, and the stored time is not the time
 *     the step showed: keep the shown time → `{ reminderTime }` (wave 5b
 *     L7). Reminders stay OFF. WHY: Today's later "Want a daily reminder?"
 *     then offers the same time as the tour (8:00 PM unless the learner
 *     changed it), not an old stored time;
 *   - a REPLAY with reminders off: nothing (a replay writes only what the
 *     learner changes, and "Not now" changes nothing).
 *
 * `stored` is the state at the tap; `shownTime` is the time on the step.
 *
 *   declineReminderPatch({ reminderEnabled: false, reminderTime: '21:00' }, '20:00', false) → { reminderTime: '20:00' }
 *   declineReminderPatch({ reminderEnabled: false, reminderTime: '21:00' }, '21:00', true)  → null
 */
export function declineReminderPatch(
  stored: Pick<OnboardingValues, 'reminderEnabled' | 'reminderTime'>,
  shownTime: string,
  replay: boolean,
): Partial<Pick<AppSettings, 'reminderEnabled' | 'reminderTime'>> | null {
  if (stored.reminderEnabled) return { reminderEnabled: false };
  if (!replay && stored.reminderTime !== shownTime) return { reminderTime: shownTime };
  return null;
}

/* -------------------------------------------------------------- copy */

/** Every fixed text of the tour (spec §8.9, exact). */
export const ONBOARDING_COPY = {
  tagline: 'Learn anything. Keep it.',
  getStarted: 'Get started',
  skip: 'Skip',
  continue: 'Continue',
  done: 'Done',
  timeTitle: 'How much time a day?',
  timeNote: 'You can change this any time.',
  reminderTitle: 'Want a daily reminder?',
  notNow: 'Not now',
  turnOff: 'Turn off reminders',
  firstTitle: 'Your first cards',
  later: "I'll do this later",
  placementTitle: 'Where do you start?',
  placementBeginner: "I'm just starting",
  adding: 'Adding your decks…',
} as const;

/** The Reminder step's main button: "Remind me at 8:00 PM". */
export function remindMeLabel(timeLabel: string): string {
  return `Remind me at ${timeLabel}`;
}

/* -------------------------------------------------------- first cards */

export type FirstCardsAction = 'import' | 'ankiweb' | 'own' | 'later';

/** One big choice of step 4. Each one STARTS the action (and marks the tour done). */
export interface FirstCardsChoice {
  action: FirstCardsAction;
  title: string;
  sub?: string;
  /** Where it goes (`router.replace`). */
  route: string;
}

/** Step 4 (spec §8.9, exact copy). A content pack's own first choice goes on top (onboarding.tsx). */
export const FIRST_CARDS_CHOICES: readonly FirstCardsChoice[] = [
  { action: 'import', title: 'Import a deck', sub: 'An Anki .apkg or a .csv file', route: '/import?source=file' },
  { action: 'ankiweb', title: 'Find a deck on AnkiWeb', sub: 'Search shared decks', route: '/import?source=ankiweb' },
  { action: 'own', title: 'Make my own deck', sub: 'Type your own cards', route: '/deck-editor' },
  { action: 'later', title: "I'll do this later", route: '/(tabs)' },
];

/**
 * The steps of the tour, in order. A replay has no step 4: it never asks for
 * a first deck again (spec §8.9).
 */
export type OnboardingStep = 'welcome' | 'time' | 'reminder' | 'first';

export function onboardingSteps(replay: boolean): OnboardingStep[] {
  return replay ? ['welcome', 'time', 'reminder'] : ['welcome', 'time', 'reminder', 'first'];
}

/** The levels of "Where do you start?" for a pack with a placement field (spec §9.4: A1 … C2). */
export const PLACEMENT_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const;
