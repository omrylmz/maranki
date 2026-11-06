/**
 * Help & FAQ content (spec §8.9, unit W4-6). Offline: everything is in this
 * file, nothing is downloaded.
 *
 * The Help screen (`/help`, src/app/help.tsx, built in wave 4b) draws these
 * sections in this order. `/help?topic=<id>` opens the screen at one section;
 * a "?" InfoSheet links to the section of its word (`GlossaryEntry.topic`).
 *
 * Topic ids are STABLE: screens and the glossary link to them, so never
 * rename one. Use `helpPath(id)` to build a link.
 *
 *   helpPath('study')        → '/help?topic=study'
 *   helpTopicParam('study')  → 'study'   (the screen reads `?topic=` with this)
 *   helpTopicParam('nope')   → null      (unknown → the screen starts at the top)
 *
 * A section is a list of blocks: paragraphs, small headings, bullet lists,
 * numbered steps, and (for "Words we use") the glossary terms. The glossary
 * terms are NOT written here a second time: the "terms" block is built from
 * src/content/glossary.ts, so Help and every InfoSheet show the same text.
 *
 * Text markup (drawn by `textSpans` in glossary.ts): `**x**` = bold (UI
 * words, the sentence that matters), `` `x` `` = code (search tokens, file
 * names). App words keep their one meaning from spec §1.2: for example
 * "Practice" never changes the schedule, and a "list" is a saved filter.
 *
 * Pure: no React, no I/O.
 */
import { GLOSSARY } from './glossary';

export { plainText, textSpans } from './glossary';
export type { SpanStyle, TextSpan } from './glossary';

/** The Help sections, in screen order (spec §8.9). Stable: links use them. */
export const HELP_TOPIC_IDS = ['words', 'study', 'filters', 'choose', 'import', 'backups', 'reminders'] as const;

/** The id of one Help section, e.g. 'study' ("How Study picks cards"). */
export type HelpTopicId = (typeof HELP_TOPIC_IDS)[number];

/** One word of "Words we use": the glossary word and its meaning. */
export interface HelpTerm {
  /** The glossary entry's id (a stable React key). */
  id: string;
  word: string;
  text: string;
}

/** One piece of a Help section. */
export type HelpBlock =
  /** A paragraph. */
  | { kind: 'text'; text: string }
  /** A small heading inside a section (drawn as an Overline). */
  | { kind: 'heading'; text: string }
  /** A list without numbers. */
  | { kind: 'bullets'; items: readonly string[] }
  /** Numbered steps, done in order. */
  | { kind: 'steps'; items: readonly string[] }
  /** Words and their meanings (the glossary). */
  | { kind: 'terms'; items: readonly HelpTerm[] };

export interface HelpSection {
  id: HelpTopicId;
  /** The section title, exactly spec §8.9. */
  title: string;
  blocks: readonly HelpBlock[];
}

/* ---------------------------------------------------------------- sections */

/** "Words we use": the §1.2 glossary, read from glossary.ts (one source). */
const WORDS: HelpSection = {
  id: 'words',
  title: 'Words we use',
  blocks: [
    {
      kind: 'text',
      text: 'Each word in Maranki has one meaning. A "?" next to a word in the app shows the same text as here.',
    },
    {
      kind: 'terms',
      items: GLOSSARY.map((entry) => ({ id: entry.id, word: entry.word, text: entry.meaning })),
    },
  ],
};

/** "How Study picks cards": the one scheduler (spec §4.5, §6.1). */
const STUDY: HelpSection = {
  id: 'study',
  title: 'How Study picks cards',
  blocks: [
    {
      kind: 'text',
      text: '**Study** is the normal session. It changes the schedule. Each time you start it, Study puts the cards in this order:',
    },
    {
      kind: 'steps',
      items: [
        '**Learning** cards whose time has come. No daily limit holds them back.',
        '**Due** reviews, the most overdue first, up to your daily review limit.',
        '**Checks**: a few Known cards come back once, to make sure you still know them. At most "Known-card checks per day" (Settings › Study & limits).',
        '**New** cards, up to your daily limit for new cards. When several decks have new cards, the decks take turns, one card each, so no deck is left behind. A deck can also have its own "New cards per day" on its deck page.',
      ],
    },
    {
      kind: 'text',
      text: '**Session size** is the most cards in one session. When there are more cards, Study cuts the list from the end, so new cards wait first. Session size applies to every session: Study, Study ahead and Practice.',
    },
    {
      kind: 'text',
      text: 'The number on every Study button is exactly the number of cards in the session it opens. This number is called **Ready**.',
    },
    { kind: 'heading', text: 'Both directions' },
    {
      kind: 'text',
      text: 'Many items have two directions, for example "German → English" and "English → German". With **Space out both directions** on (Settings › Study & limits), Study never shows both directions of one item on the same day. The other direction comes on a later day.',
    },
    { kind: 'heading', text: 'What Study leaves out' },
    {
      kind: 'bullets',
      items: [
        'Not started cards, until you choose them.',
        'Known cards, except a Check now and then.',
        'Suspended cards, until you unsuspend them.',
        'Buried cards, until tomorrow.',
        'Directions that you turned off for a deck.',
        'The cards of a paused deck. You can still study a paused deck from its deck page.',
      ],
    },
    { kind: 'heading', text: 'Limits and goals' },
    {
      kind: 'text',
      text: 'A **daily limit** is the most new cards or reviews Study gives you per day. A **daily goal** only fills the bars on Today. It never blocks cards.',
    },
    { kind: 'heading', text: 'When you are caught up' },
    {
      kind: 'bullets',
      items: [
        '**Study ahead** shows reviews that are not due yet, soonest first. It changes the schedule.',
        '**Practice** is free practice. It never changes the schedule or your daily counts. A practice session still counts for your streak.',
      ],
    },
  ],
};

/** "Filters and lists": chips, filter groups, search tokens, lists (spec §4.1–§4.3, §4.7, §8.3). */
const FILTERS: HelpSection = {
  id: 'filters',
  title: 'Filters and lists',
  blocks: [
    {
      kind: 'text',
      text: 'The Library shows your cards. Each **filter** is a chip above the list, for example "Level: B1, B2". Tap × on a chip to remove it. **Clear all** removes every filter.',
    },
    {
      kind: 'text',
      text: 'Inside one chip, a card needs only one of the values: Level B1 or B2. With two chips, a card must match both: Level B1 and Not started.',
    },
    {
      kind: 'text',
      text: 'Tap **+ Filter** to see the filter groups of your cards, with counts. Status, Due and Markers are always there. The other groups come from your data: a field such as Level or Type, the sections of an Anki deck, tags, card types and directions. Such a group shows only when it has two or more values here.',
    },
    { kind: 'heading', text: 'Search' },
    {
      kind: 'text',
      text: 'Words in the search box look in every field. Capitals and accents do not matter: "uber" finds "über". Some words become chips:',
    },
    {
      kind: 'bullets',
      items: [
        '`deck:german`, `section:verbs`, `tag:verb`, and `-tag:verb` for cards without that tag.',
        'A field name with a value, for example `level:b1` or `type:verb`.',
        '`is:new`, `is:notstarted`, `is:learning`, `is:review`, `is:mastered`, `is:known`.',
        '`is:due`, `is:duetoday`.',
        '`is:fav`, `is:flagged`, `is:suspended`, `is:buried`, `is:paused`.',
        '`is:hard`, `is:recent`, `is:leech`.',
      ],
    },
    { kind: 'heading', text: 'Lists' },
    {
      kind: 'text',
      text: 'A **list** is a saved filter, like "B1 verbs". Choose filters in the Library, then tap **Save as list**. A list is always up to date: new cards that match it appear in it by themselves.',
    },
    {
      kind: 'text',
      text: 'A list is not a folder. One card can be in many lists, and deleting a list never deletes cards.',
    },
    {
      kind: 'text',
      text: 'Maranki also has built-in lists: Favorites, Flagged, Hard cards, Recent cards, Suspended and Leeches. You can always find your suspended cards in the Suspended list.',
    },
  ],
};

/** "Choosing what to learn": Not started, Known, triage (spec §8.5, §8.2, §5.9). */
const CHOOSE: HelpSection = {
  id: 'choose',
  title: 'Choosing what to learn',
  blocks: [
    {
      kind: 'text',
      text: 'A big deck does not have to come into your queue all at once. Cards can start as **Not started**: they stay in the deck, but Study does not show them until you choose them.',
    },
    {
      kind: 'text',
      text: 'Open **Choose what to learn** from a deck page or from Today, or tap **Choose** in the Library. You see each item with its front and back together. For each one, choose:',
    },
    {
      kind: 'bullets',
      items: [
        '**Learn**: it joins your queue as New, in deck order. Study brings in a few new cards each day.',
        '**I know it**: it becomes Known and is not studied. A few Known cards come back once for a **Check**. If you miss a Check, the card moves to Learning.',
        '**Later**: it stays Not started and moves to the end of this round.',
      ],
    },
    {
      kind: 'text',
      text: 'Swipe right to learn, or swipe left for "I know it". The buttons do the same. **Undo** takes back your last choice.',
    },
    {
      kind: 'text',
      text: 'A choice counts for every direction of the item. To change one direction alone, open the card in the Library and change its status.',
    },
    { kind: 'heading', text: 'Faster ways' },
    {
      kind: 'bullets',
      items: [
        '"Learn all" and "Mark all known" take every item that is left in this round.',
        'On a deck page, "Add the next 50 in order" adds the next 50 items to your queue.',
        'When you import a deck with levels, "Where do you start?" can mark the easier levels as Known.',
        'In the Library, select cards, then tap More › "Learn these" or "Mark as known".',
      ],
    },
    {
      kind: 'text',
      text: 'Changed your mind? Open the card in the Library. Its status can be Not started, In queue or Known. "Not started" works only for a card that you have never studied.',
    },
  ],
};

/** "Import tips" (spec §5, §7 rows 62–63). */
const IMPORT: HelpSection = {
  id: 'import',
  title: 'Import tips',
  blocks: [
    { kind: 'heading', text: 'From Anki' },
    {
      kind: 'steps',
      items: [
        'In Anki on a computer, choose File › Export.',
        'Choose "Anki Deck Package (*.apkg)".',
        'Check **Support older Anki versions**. Without it, Anki writes a newer file format that Maranki cannot read yet.',
        'Put the file on your phone, then tap **Import a file** in Maranki.',
      ],
    },
    {
      kind: 'text',
      text: 'Maranki keeps every field, both directions, tags, subdecks (as sections), images and your Anki progress. When you import the same deck again, the cards you already have are updated and keep their progress.',
    },
    {
      kind: 'text',
      text: 'To search the decks that other people share, tap **Find on AnkiWeb**.',
    },
    { kind: 'heading', text: 'Spreadsheets (CSV)' },
    {
      kind: 'bullets',
      items: [
        'Put the field names in the first row, for example `Word,Translation,Level,Type`. Each name becomes a field.',
        'A column with a few repeated values, like Level, becomes a filter by itself.',
        'Without a first row of names, Maranki reads the columns in this order: front, back, example, one more detail, then tags.',
        'In the Fields step, you choose what each column does: Front, Back, Example, Show on back, Filter, Tags or Ignore.',
      ],
    },
    { kind: 'heading', text: 'Anki text exports' },
    {
      kind: 'text',
      text: 'Anki can also export "Notes in Plain Text". Maranki reads the header lines of that file, such as `#separator`, `#html`, `#columns`, `#tags column`, `#guid column`, `#deck column` and `#notetype column`. These lines never become cards. With a guid column, importing the file again updates your cards instead of making copies.',
    },
    { kind: 'heading', text: 'Not imported yet' },
    {
      kind: 'bullets',
      items: [
        '**Audio.** Sound clips are not imported yet. The cards keep their text.',
        "Anki's newest file format (`collection.anki21b`). Export the deck again with **Support older Anki versions** checked.",
      ],
    },
  ],
};

/** "Backups and moving phones" (spec §8.4). */
const BACKUPS: HelpSection = {
  id: 'backups',
  title: 'Backups and moving phones',
  blocks: [
    {
      kind: 'text',
      text: 'Maranki has no account and no cloud. Your cards are only on this phone. A **backup** is one file with all your decks, cards, progress and settings.',
    },
    { kind: 'heading', text: 'Make a backup' },
    {
      kind: 'text',
      text: 'Go to Settings › Your data › **Export a backup**. The share sheet opens: save the file in Files or Drive, or send it to yourself.',
    },
    {
      kind: 'text',
      text: '**Automatic backups** keep the last 3 weekly backups on this phone. They do not help when the phone is lost or broken, so also export a backup from time to time.',
    },
    {
      kind: 'text',
      text: 'Images go into a backup when "Include images in backups" is on and all images together are 50 MB or less.',
    },
    { kind: 'heading', text: 'Move to a new phone' },
    {
      kind: 'steps',
      items: [
        'On the old phone, go to Settings › Your data › **Export a backup**. Save the file where the new phone can open it, for example in Drive or in an email to yourself.',
        'On the new phone, install Maranki. Go to Settings › Your data › **Restore a backup** and choose the file.',
        'Check what the backup has, then hold the button to restore.',
      ],
    },
    {
      kind: 'text',
      text: '**Restore replaces everything on the phone.** Maranki saves a backup of the current data first.',
    },
    {
      kind: 'text',
      text: 'Do not uninstall Maranki or clear its storage before you have a backup. That deletes your cards.',
    },
  ],
};

/**
 * "Reminders not arriving?" (spec §8.7). The first two sentences are the
 * same words as the line on Settings › Reminders (reminderSync.ts
 * `REMINDER_COPY.late`). They say the real delay: Android schedules the
 * reminders as inexact alarms, up to an hour late (release pass 2026-11-02,
 * C1-1; it was "a few minutes").
 *
 * The first bullet quotes BOTH forms of the screen's "next reminder" line
 * (reminderSync.ts `reminderStatusLine`). WHY (wave 5h, device note 9): it
 * said the "Next reminder" line "shows a time", but on a day you already
 * studied (with "Skip days when I already studied" on) the line reads
 * "Today is done — next: tomorrow at 8:00 PM", so Help did not match.
 */
const REMINDERS: HelpSection = {
  id: 'reminders',
  title: 'Reminders not arriving?',
  blocks: [
    {
      kind: 'text',
      text: 'Reminders may arrive up to an hour late. Android holds them back to save battery. If they do not arrive at all, check these:',
    },
    {
      kind: 'bullets',
      items: [
        'In Settings › Reminders, **Daily reminder** is on and the screen says when the next reminder comes, for example "Next reminder: today at 8:00 PM" or "Today is done — next: tomorrow at 8:00 PM".',
        'With **Skip days when I already studied** on, there is no reminder on a day when you already studied.',
        'If you see "Notifications are turned off for Maranki", tap **Open system settings** and allow notifications.',
        '**Battery optimization**: some phones stop apps in the background to save battery. In the system settings, find Maranki and let it run in the background. The name of this setting is different on each phone.',
        '"Do not disturb" or a Focus mode can hide notifications.',
        'Maranki plans the next 14 reminders when you use the app. If you do not open it for two weeks, the reminders stop until you open it again.',
      ],
    },
  ],
};

/** Every Help section, in screen order (the order of HELP_TOPIC_IDS). */
export const HELP_SECTIONS: readonly HelpSection[] = [WORDS, STUDY, FILTERS, CHOOSE, IMPORT, BACKUPS, REMINDERS];

/* ------------------------------------------------------------------ lookup */

/** True when `value` is a Help topic id. */
export function isHelpTopicId(value: string): value is HelpTopicId {
  return (HELP_TOPIC_IDS as readonly string[]).includes(value);
}

/**
 * The section with this id, or null.
 *
 *   helpSection('import')?.title → 'Import tips'
 *   helpSection('nope')          → null
 */
export function helpSection(id: string): HelpSection | null {
  return HELP_SECTIONS.find((section) => section.id === id) ?? null;
}

/**
 * The `?topic=` route param of `/help` → a topic id, or null (no param, or
 * an unknown one: the screen then starts at the top). expo-router gives an
 * array when the param repeats; the first value counts.
 *
 *   helpTopicParam('study')      → 'study'
 *   helpTopicParam(['import'])   → 'import'
 *   helpTopicParam(undefined)    → null
 */
export function helpTopicParam(raw: string | string[] | undefined): HelpTopicId | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value !== undefined && isHelpTopicId(value) ? value : null;
}

/**
 * The path of the Help screen, at one section when `topic` is given.
 * A plain string: the caller casts it to expo-router's `Href` (the route
 * file src/app/help.tsx comes with wave 4b).
 *
 *   helpPath()          → '/help'
 *   helpPath('backups') → '/help?topic=backups'
 */
export function helpPath(topic?: HelpTopicId): string {
  return topic === undefined ? '/help' : `/help?topic=${topic}`;
}

/**
 * Every text of a section, markup included, in reading order (the terms
 * block gives each word, then its meaning). For tests and a future search.
 */
export function sectionTexts(section: HelpSection): string[] {
  const out: string[] = [section.title];
  for (const block of section.blocks) {
    if (block.kind === 'text' || block.kind === 'heading') out.push(block.text);
    else if (block.kind === 'terms') for (const term of block.items) out.push(term.word, term.text);
    else out.push(...block.items);
  }
  return out;
}
