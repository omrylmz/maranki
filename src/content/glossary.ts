/**
 * The glossary — one meaning per word (spec §1.2, unit W4-6).
 *
 * This is the ONE place where the app says what its words mean. The Help
 * screen ("Words we use", src/content/help.ts) and every "?" InfoSheet
 * (src/components/sheets/InfoSheet.tsx) read their text from here, so the
 * app and Help can never disagree.
 *
 * Each entry is one row of the spec §1.2 table, in the same order:
 *   - `word`    the UI word, exactly as the spec writes it ("Not started");
 *   - `code`    the code word(s) behind it, exactly as the spec writes them
 *               (backticks mark code). For developers only: never shown;
 *   - `meaning` the one meaning, exactly the spec's text. It is user copy:
 *               the InfoSheet and Help show it. `**x**` marks bold text
 *               (see `textSpans` below);
 *   - `topic`   (optional) the Help section that says more about the word.
 *
 * One row is special. The spec's "Note" row has no UI word: "The UI never
 * says 'note'". When a screen must count notes, it says "{n} items". So the
 * entry is called "Item", and its meaning is the spec's first two sentences
 * with "note" → "item". The spec's other sentences there are rules for
 * developers (never write the noun "note" in the UI), not user copy.
 *
 * glossary.test.ts reads the §1.2 table from docs/product-spec.md and checks
 * that every UI word has exactly one entry here, with the same code word and
 * the same meaning.
 *
 * Example:
 *   glossaryEntry('known')?.meaning
 *     → 'You said you already know it. It is not studied. A few Known cards come back once for a **Check**.'
 *
 * Pure: no React, no I/O.
 */
import { foldText } from '../domain/text';
import type { HelpTopicId } from './help';

export interface GlossaryEntry {
  /** Stable key, e.g. 'notStarted'. Never shown; used as a React key and by tests. */
  id: string;
  /** The UI word, exactly as spec §1.2 writes it, e.g. 'Not started' or 'Favorite / Flag'. */
  word: string;
  /**
   * Other spellings that find this entry with `glossaryEntry`, e.g. the two
   * halves of "Favorite / Flag", or "Pause deck" (the deck page's toggle).
   */
  aliases?: readonly string[];
  /** The code word(s), exactly as spec §1.2 writes them (backticks mark code). Never shown. */
  code: string;
  /** The one meaning: user copy, exactly spec §1.2. `**x**` = bold. */
  meaning: string;
  /** The Help section that explains more (src/content/help.ts), if any. */
  topic?: HelpTopicId;
}

/** Every word of spec §1.2, in the table's order. */
export const GLOSSARY: readonly GlossaryEntry[] = [
  {
    id: 'deck',
    word: 'Deck',
    code: '`Deck`',
    meaning: 'A container of cards that you own. Every card is in exactly one deck.',
  },
  {
    id: 'section',
    word: 'Section',
    code: '`Note.section`',
    meaning:
      'A part of a deck that came from an Anki subdeck, for example "Verbs › B1". It is a filter, not a place with its own settings.',
    topic: 'filters',
  },
  {
    id: 'card',
    word: 'Card',
    code: '`Card`',
    meaning: 'One thing you study, with its own schedule.',
  },
  {
    id: 'direction',
    word: 'Direction',
    code: '`TemplateDef` / `Card.ord`',
    meaning:
      'Which side is the question. "German → English" and "English → German" are two directions of the same information.',
    topic: 'study',
  },
  {
    // The spec's "(not shown)" Note row: see the top of this file.
    id: 'item',
    word: 'Item',
    code: '`Note`',
    meaning: 'The information you enter once (field values, tags, section). An item has one card per enabled direction.',
  },
  {
    id: 'cardType',
    word: 'Card type',
    code: '`NoteType`',
    meaning: 'The list of fields and directions shared by many cards, for example "German Verbs".',
  },
  {
    id: 'field',
    word: 'Field',
    code: '`FieldDef` + `Note.fields[i]`',
    meaning: 'One named piece of information, for example "Level" or "Conjugation".',
    topic: 'filters',
  },
  {
    id: 'filter',
    word: 'Filter',
    code: 'one group in `Query`',
    meaning: 'A removable chip that narrows a card list, for example "Level: B1, B2 ×".',
    topic: 'filters',
  },
  {
    id: 'filterGroup',
    word: 'Filter group',
    code: '`Facet`',
    meaning:
      'The values of one filter that exist in your data, with counts, for example "Level: A1 (581) · A2 (520)".',
    topic: 'filters',
  },
  {
    id: 'list',
    word: 'List',
    code: '`ListDef`',
    meaning:
      'A saved filter, like "B1 verbs". It is always up to date. It is not a folder: one card can match many lists. (Replaces "Collection".)',
    topic: 'filters',
  },
  {
    id: 'notStarted',
    word: 'Not started',
    code: "`Card.newState === 'notStarted'`",
    meaning: 'The card is in a deck but not in your study queue. Study never shows it until you choose it.',
    topic: 'choose',
  },
  {
    id: 'new',
    word: 'New',
    code: "`reps === 0`, `newState !== 'notStarted'`",
    meaning: 'In your queue, waiting for its first study. Study brings in a few each day.',
    topic: 'study',
  },
  {
    id: 'learning',
    word: 'Learning',
    code: '`stepIndex !== null`',
    meaning: 'Seen recently. Comes back in minutes.',
    topic: 'study',
  },
  {
    id: 'review',
    word: 'Review',
    code: 'graduated, interval < 21 days',
    meaning: 'Comes back in days.',
    topic: 'study',
  },
  {
    id: 'mastered',
    word: 'Mastered',
    code: 'graduated, interval ≥ 21 days, not Known',
    meaning: 'Long-term memory.',
    topic: 'study',
  },
  {
    id: 'known',
    word: 'Known',
    code: '`knownAt != null`',
    meaning: 'You said you already know it. It is not studied. A few Known cards come back once for a **Check**.',
    topic: 'choose',
  },
  {
    id: 'check',
    word: 'Check',
    code: 'spot-check bucket',
    meaning: 'One quick test of a Known card, to make sure. If you miss it, the card moves to Learning.',
    topic: 'study',
  },
  {
    id: 'due',
    word: 'Due',
    code: '`isDueNow()`',
    meaning: 'A Learning/Review/Mastered card whose time has come. A separate filter, not a status.',
    topic: 'study',
  },
  {
    id: 'ready',
    word: 'Ready',
    code: '`ReadyCounts.total`',
    meaning:
      "Learning + due reviews + checks + today's new cards, inside your daily limits and session size. **This is the number on every Study button.**",
    topic: 'study',
  },
  {
    id: 'study',
    word: 'Study',
    code: 'session kind `scheduled`',
    meaning: 'The normal session. **It changes the schedule.**',
    topic: 'study',
  },
  {
    id: 'studyAhead',
    word: 'Study ahead',
    code: 'kind `ahead`',
    meaning: 'Reviews that are not due yet, soonest first. It changes the schedule.',
    topic: 'study',
  },
  {
    id: 'practice',
    word: 'Practice',
    code: 'kind `practice`',
    meaning:
      'Free practice. **It never changes the schedule or your daily counts.** (Replaces "Cram" and "Review hardest".)',
    topic: 'study',
  },
  {
    id: 'chooseWhatToLearn',
    word: 'Choose what to learn',
    code: '`/triage`',
    meaning: 'Sorting Not started cards into Learn / I know it / Later.',
    topic: 'choose',
  },
  {
    id: 'dailyGoal',
    word: 'Daily goal',
    aliases: ['Daily goals'],
    code: '`person.goalReviews/goalNew`',
    meaning: 'A target for the bars on Today. **It never blocks cards.**',
    topic: 'study',
  },
  {
    id: 'dailyLimit',
    word: 'Daily limit',
    aliases: ['Daily limits'],
    code: '`srs.dailyNewLimit/dailyReviewLimit`',
    meaning: 'The most new cards / reviews Study gives you per day.',
    topic: 'study',
  },
  {
    id: 'sessionSize',
    word: 'Session size',
    code: '`settings.sessionLimit`',
    meaning: 'The most cards in one session. Applies to **every** session.',
    topic: 'study',
  },
  {
    id: 'bury',
    word: 'Bury',
    code: '`buriedUntil`',
    meaning: 'Hide a card until tomorrow.',
    topic: 'study',
  },
  {
    id: 'suspend',
    word: 'Suspend',
    code: '`suspended`',
    meaning: 'Hide a card until you unsuspend it.',
    topic: 'filters',
  },
  {
    id: 'favoriteFlag',
    word: 'Favorite / Flag',
    aliases: ['Favorite', 'Flag'],
    code: '`fav` / `flagged`',
    meaning: 'Your own markers. They never change the schedule.',
    topic: 'filters',
  },
  {
    id: 'pauseDeck',
    word: 'Pause a deck',
    // "Pause deck" is the deck page's toggle; "Paused" is Today's row.
    aliases: ['Pause deck', 'Paused'],
    code: '`Deck.active === false`',
    meaning: "The deck's cards leave Today. You can still study it from its deck page.",
    topic: 'study',
  },
  {
    id: 'hint',
    word: 'Hint',
    code: '`hints.ts`',
    meaning: 'Shows part of the answer before you reveal it.',
  },
  {
    id: 'streakFreeze',
    word: 'Streak / Freeze',
    aliases: ['Streak', 'Freeze'],
    code: '`person.streak/freezes`',
    meaning: 'Days in a row you studied. A freeze saves one missed day.',
  },
  {
    id: 'backup',
    word: 'Backup',
    code: '`maranki-backup` file',
    meaning: 'One file with all your decks, cards, progress and settings.',
    topic: 'backups',
  },
];

/* ------------------------------------------------------------------ lookup */

/**
 * The form of a word used for lookups: folded (lower case, no accents) and
 * with single spaces.
 *
 *   lookupKey('  Not   Started ') → 'not started'
 */
export function lookupKey(term: string): string {
  return foldText(term).trim().split(/\s+/).join(' ');
}

/** Lookup key → entry: every word, alias and id. Built once, when the module loads. */
const BY_KEY: ReadonlyMap<string, GlossaryEntry> = (() => {
  const map = new Map<string, GlossaryEntry>();
  for (const entry of GLOSSARY) {
    for (const name of [entry.word, entry.id, ...(entry.aliases ?? [])]) map.set(lookupKey(name), entry);
  }
  return map;
})();

/**
 * The entry for a word, or null when the glossary does not have it.
 * Case, accents and extra spaces do not matter; an alias or an id works too.
 *
 *   glossaryEntry('Not started') → the "Not started" entry
 *   glossaryEntry('flag')        → the "Favorite / Flag" entry (an alias)
 *   glossaryEntry('notStarted')  → the "Not started" entry (the id)
 *   glossaryEntry('Note')        → null (the UI never says "note")
 */
export function glossaryEntry(term: string): GlossaryEntry | null {
  return BY_KEY.get(lookupKey(term)) ?? null;
}

/**
 * The entry for a word that a SCREEN asks for (an InfoButton, an InfoSheet).
 * A word the glossary does not have is a bug in that screen (a typo), so:
 *   - in development (`dev: true`) it throws: the red screen names the word;
 *   - in a release it returns null: the screen shows no "?" at all, because a
 *     "?" that explains nothing would be a fake control.
 *
 * The caller passes `dev` (components pass `__DEV__`), so this stays pure
 * and both cases can be tested.
 */
export function requireGlossaryEntry(term: string, opts: { dev: boolean }): GlossaryEntry | null {
  const entry = glossaryEntry(term);
  if (entry === null && opts.dev) {
    throw new Error(`"${term}" is not in the glossary (src/content/glossary.ts). Use a UI word from spec §1.2.`);
  }
  return entry;
}

/* ------------------------------------------------------------ text markup */

/** How one piece of content text is drawn. */
export type SpanStyle = 'plain' | 'bold' | 'code';

export interface TextSpan {
  text: string;
  style: SpanStyle;
}

/**
 * Split content text (a glossary meaning, a Help paragraph) into pieces with
 * a style. The markup is tiny, on purpose:
 *   - `**bold**`  → bold (a UI word, or a sentence that matters);
 *   - `` `code` `` → code (a search token like `is:due`, a file name).
 * A marker without its closing pair is plain text. Markers do not nest.
 *
 *   textSpans('Tap **Save as list**.')
 *     → [{ text: 'Tap ', style: 'plain' }, { text: 'Save as list', style: 'bold' }, { text: '.', style: 'plain' }]
 *   textSpans('Type `is:due`') → [{ text: 'Type ', style: 'plain' }, { text: 'is:due', style: 'code' }]
 */
export function textSpans(text: string): TextSpan[] {
  const spans: TextSpan[] = [];
  let plain = '';
  let i = 0;
  const push = (piece: string, style: SpanStyle) => {
    if (plain !== '') spans.push({ text: plain, style: 'plain' });
    plain = '';
    spans.push({ text: piece, style });
  };
  while (i < text.length) {
    if (text.startsWith('**', i)) {
      const close = text.indexOf('**', i + 2);
      if (close > i + 2) {
        push(text.slice(i + 2, close), 'bold');
        i = close + 2;
        continue;
      }
    } else if (text[i] === '`') {
      const close = text.indexOf('`', i + 1);
      if (close > i + 1) {
        push(text.slice(i + 1, close), 'code');
        i = close + 1;
        continue;
      }
    }
    plain += text[i];
    i += 1;
  }
  if (plain !== '') spans.push({ text: plain, style: 'plain' });
  return spans;
}

/**
 * Content text without its markup, e.g. for a screen-reader label or a search.
 *
 *   plainText('**Study** · `is:due`') → 'Study · is:due'
 */
export function plainText(text: string): string {
  return textSpans(text)
    .map((span) => span.text)
    .join('');
}
