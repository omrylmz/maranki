/**
 * The words on the two "something is wrong" screens (spec W1-4, §3.10).
 *
 *   - ErrorScreen — a screen crashed (a JavaScript error while rendering).
 *     Shown by the `ErrorBoundary` export of the root and (tabs) layouts.
 *   - DataProblemScreen — the saved data could not be opened, so every write
 *     is blocked (C1). Shown by the root layout INSTEAD of the app.
 *
 * Pure: no React and no native modules, so problemCopy.test.ts can pin every
 * text exactly. The screens only read from here; they never spell the words
 * themselves.
 */
import type { PersistError } from './actions';

/* ------------------------------------------------------- data problems */

/**
 * The persistence errors that block the whole app. For these three the data
 * layer is "read-blocked": nothing is saved, and the root layout shows the
 * DataProblemScreen instead of the tabs. ('write' is not one of them: the
 * data is open, only the last save failed, so a snackbar is enough.)
 */
export type DataProblem = Extract<PersistError, 'read' | 'too-new' | 'migrate'>;

/** The DataProblem for a persistence error, or null when the app can run normally. */
export function dataProblemOf(error: PersistError): DataProblem | null {
  return error === 'read' || error === 'too-new' || error === 'migrate' ? error : null;
}

/**
 * The buttons a DataProblemScreen can show:
 *   - 'retry'  — "Try again": loads the saved data again (the root layout
 *                remounts the DataProvider).
 *   - 'rescue' — "Save a copy of the raw data": rescueExport.ts.
 *   - 'help'   — "Help": shows the `help` lines on the same screen. (The
 *                screen cannot open another route: no navigator is mounted
 *                while it is shown.)
 */
export type ProblemAction = 'retry' | 'rescue' | 'help';

export interface ProblemCopy {
  title: string;
  body: string;
  /** Buttons, in the order they are shown. The first one is the main button. */
  actions: readonly ProblemAction[];
  /** The text the "Help" button shows: one short step per line. */
  help: readonly string[];
}

/** Button labels of the DataProblemScreen. */
export const PROBLEM_BUTTON: Record<ProblemAction, string> = {
  retry: 'Try again',
  rescue: 'Save a copy of the raw data',
  help: 'Help',
};

/** The last help line of every problem: the one mistake that really loses data. */
const KEEP_THE_APP =
  'Do not uninstall Maranki and do not clear its storage. That deletes your cards.';

/** Title and body text are exactly spec §3.10. */
export const DATA_PROBLEM_COPY: Record<DataProblem, ProblemCopy> = {
  read: {
    title: "We couldn't open your saved data.",
    body: 'Your cards are still on this phone. Nothing was changed.',
    actions: ['retry', 'rescue', 'help'],
    help: [
      'Close Maranki completely, then open it again.',
      'If your phone is almost full, free some space, then tap "Try again".',
      'Tap "Save a copy of the raw data" to keep a copy somewhere safe, for example in Files or in an email to yourself.',
      KEEP_THE_APP,
    ],
  },
  'too-new': {
    title: 'This data was saved by a newer version of Maranki.',
    body: 'Please update the app. Nothing was changed.',
    // "Try again" cannot help here: this version of the app will never read
    // newer data. Updating the app is the fix.
    actions: ['rescue', 'help'],
    help: [
      'This version of Maranki is older than the one that saved your data, so it does not change anything.',
      'Install the newest version of Maranki, then open it again.',
      'Tap "Save a copy of the raw data" to keep a copy somewhere safe.',
      KEEP_THE_APP,
    ],
  },
  migrate: {
    title: "We couldn't update your data to this version.",
    body: 'Nothing was changed. Please send us a copy.',
    actions: ['retry', 'rescue', 'help'],
    help: [
      'This is a bug in Maranki, not a problem with your cards. Your saved data was not changed.',
      'Tap "Save a copy of the raw data" and send the file to us when you report the problem.',
      'When a newer version of Maranki is available, install it and open the app again.',
      KEEP_THE_APP,
    ],
  },
};

/* -------------------------------------------------------------- crashes */

/** Exactly the spec W1-4 text of the ErrorScreen. */
export const CRASH_COPY = {
  title: 'Something went wrong',
  body: 'Your cards and progress are saved. You can try again, or save a copy of your data first.',
  retry: 'Try again',
  rescue: 'Save a copy of my data',
} as const;

/* ------------------------------------------------- "save a copy" result */

/**
 * What one "Save a copy" press did (rescueExport.ts returns it):
 *   - shared       — the copy was written to a file and the share sheet opened.
 *   - saved        — sharing is not possible here, so the copy was kept in the
 *                    app's own files (`backups/` folder) instead.
 *   - nothing      — nothing is stored on this phone, so there is nothing to copy.
 *   - read-failed  — the stored text could not be read.
 *   - write-failed — the copy file could not be written.
 */
export type RescueOutcome =
  | { kind: 'shared'; fileName: string }
  | { kind: 'saved'; fileName: string }
  | { kind: 'nothing' }
  | { kind: 'read-failed' }
  | { kind: 'write-failed' };

/**
 * The line shown under the buttons after a "Save a copy" press, or null when
 * the share sheet itself was the answer. (These screens have no snackbar host,
 * so the result is written on the screen.)
 */
export function rescueMessage(outcome: RescueOutcome): string | null {
  switch (outcome.kind) {
    case 'shared':
      return null;
    case 'saved':
      return `Sharing is not available, so the copy was saved inside Maranki as ${outcome.fileName}.`;
    case 'nothing':
      return 'There is no saved data on this phone to copy.';
    case 'read-failed':
      return "We couldn't read the saved data, so no copy was made. Your cards are still on this phone.";
    case 'write-failed':
      return "We couldn't write the copy. Your phone may be out of storage.";
  }
}
