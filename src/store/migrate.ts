/**
 * Schema migration (spec §3.1–§3.5): turn ANY document an old build saved into
 * today's schema — schema 3, the note model — or say exactly why it cannot be
 * read. Pure: no I/O, and the clock comes in as `now`.
 *
 * WHY: the public v2.0.2 APK saved `word`/`tr` cards under the same storage key
 * that main@1333d48 reads as `front`/`back` cards, and wave 3 moved the card
 * text into notes. Without these steps an update loaded cards with no text,
 * and Study, search and A–Z sort crashed.
 *
 * The three outcomes of `migrate()`:
 *   - ok      — a document of schema 3 (or a newer one we may read), repaired
 *               and with every default filled in;
 *   - too-new — a newer app saved it and says older apps must not read it.
 *               The caller blocks every write (spec §3.1 rule 6);
 *   - invalid — not a Maranki document at all (the caller treats it as corrupt).
 * If `migrate()` THROWS, that is a bug in this file: the caller blocks writes
 * ('migrate'), it never treats the data as corrupt (spec §3.1 rule 7).
 *
 * THE CHAIN (W3-1 wires the v3 part):
 *
 *   not a document? → too new? → not state-shaped?
 *     schema 0/1/2:  v0toV2 / v1toV2 → sanitizeV2 → mergeDefaultsV2   (= migrateToV2)
 *                    → v2toV3 (migrateV3.ts)
 *     schema 3:      (already the note model)
 *   → checkIntegrity (checkIntegrity.ts) → sanitize → mergeDefaults → the version fields.
 *
 * WHY the v2 repairs run BEFORE v2toV3: they repair the card TEXT
 * (`front: 42` → "42") and list each repair. After v2toV3 the text is inside
 * a note field, and nothing could tell a repaired '' from a real ''.
 * `sanitize` and `mergeDefaults` (without "V2") are the v3 ones: they repair
 * the numbers and fill the defaults of a v3 document, so a v3 document from
 * storage or from a backup is as safe as a migrated one.
 *
 * Rules every step keeps:
 *   - Never drop the user's data. Old values with no place yet go into
 *     `legacy` copies (and into note fields at v3); bad numbers get safe
 *     defaults; a card whose deck is missing moves to "Unfiled cards". Each
 *     repair is listed in `repaired`.
 *   - Unknown keys survive (every step spreads objects), so a newer document
 *     that we may read keeps the fields we do not know.
 *   - Idempotent: migrating the result again changes nothing.
 *
 * Example:
 *   const out = migrate(JSON.parse(storedText), Date.now());
 *   if (out.kind === 'ok') use(out.state);   // out.from = the version it had
 */
import { DEFAULT_LIST_ICON } from '../domain/lists';
import { MANUAL_LOG_MAX_EDITS, MANUAL_LOG_MAX_SNAPSHOTS, snapshotCount } from '../domain/manualLog';
import { buildSeedState } from '../domain/seed';
import {
  AppSettings,
  AppSettingsV2,
  CardV2,
  CURRENT_SCHEMA,
  DataState,
  DataStateV2,
  DayDone,
  DayDoneV2,
  DeckV2,
  DEFAULT_APP_SETTINGS,
  DEFAULT_APP_SETTINGS_V2,
  DEFAULT_SRS,
  LegacyCardV0,
  LegacyDeckV0,
  ManualEdit,
  MIN_READER,
  Person,
  PersonV2,
  ReviewBucket,
  SessionKind,
  SortSpec,
  SourceKind,
  SrsSettings,
  StudyMode,
} from '../domain/types';
import { checkIntegrity, tagsFrom } from './checkIntegrity';
import { UNFILED_DECK_ID, unfiledDeckV2 } from './deckOps';
import { v2toV3 } from './migrateV3';

export { CURRENT_SCHEMA, MIN_READER };

/* ----------------------------------------------------------------- types */

export type MigrateOutcome =
  /** `from` is the version the document had; `repaired` lists every repair, in readable words. */
  | { kind: 'ok'; state: DataState; from: number; repaired: string[] }
  /** `version` is the document's own schemaVersion. */
  | { kind: 'too-new'; version: number }
  /** Not a Maranki document. */
  | { kind: 'invalid' };

/** The outcome of `migrateToV2`: the same three kinds, with a schema-2 state. */
export type MigrateOutcomeV2 =
  | { kind: 'ok'; state: DataStateV2; from: number; repaired: string[] }
  | { kind: 'too-new'; version: number }
  | { kind: 'invalid' };

type Obj = Record<string, unknown>;

/**
 * A stored document of schema 0 (v2.0.x, German fork) or schema 1
 * (main@1333d48). There is no exact type for old data: these are the parts the
 * migration steps read. Everything else passes through unchanged.
 */
export interface LegacyDoc {
  cards: unknown[];
  decks: unknown[];
  settings: Obj;
  person: Obj;
  [key: string]: unknown;
}
export type LegacyV0Doc = LegacyDoc;
export type LegacyV1Doc = LegacyDoc;

/* ---------------------------------------------------------- small checks */

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** A whole number ≥ 0 (a counter, an index or a version). */
const isCount = (v: unknown): v is number => isFiniteNum(v) && Number.isInteger(v) && v >= 0;
const isString = (v: unknown): v is string => typeof v === 'string';
/** A usable id: a text that is not empty. */
const isId = (v: unknown): v is string => isString(v) && v !== '';
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

/** A value as a short readable text for the repair list. NaN stays "NaN"; a missing key is "missing". */
function show(v: unknown): string {
  if (v === undefined) return 'missing';
  if (typeof v === 'number') return String(v);
  return JSON.stringify(v) ?? String(v);
}

/** SM-2 never lets the ease go below 130 % (srs.ts); a stored lower ease is repaired to it. */
const MIN_EASE = 1.3;

/** The last schema whose cards hold their own text (`front`/`back`). */
const LAST_TEXT_SCHEMA = 2;

/**
 * The minimum shape the app needs to read a document: card and deck lists,
 * and person and settings objects. Every schema (0 to 3) has them.
 * Deliberately shallow: the steps repair everything inside. A document
 * without this shape is 'invalid' (the caller keeps a copy of it and starts
 * from the seed).
 */
export function isValidState(value: unknown): value is DataState {
  return (
    isObj(value) &&
    Array.isArray(value.cards) &&
    Array.isArray(value.decks) &&
    isObj(value.person) &&
    isObj(value.settings)
  );
}

/* -------------------------------------------------------- detectVersion */

/**
 * The schema of a stored document (spec §3.1). A document with a
 * `schemaVersion` says it itself. The two old schemas have no version field,
 * so their SHAPE tells them apart:
 *   - 0 (v2.0.x, German fork): a card has a text `word` and no text `front`;
 *     or, with no cards, a deck has `flag` and no `icon`; or the settings have
 *     the old `ttsEnabled` switch and no `readAloudEnabled`;
 *   - 1 (main@1333d48): every other document without `schemaVersion`.
 */
export function detectVersion(doc: Record<string, unknown>): number {
  if (typeof doc.schemaVersion === 'number') return doc.schemaVersion;
  const cards = Array.isArray(doc.cards) ? doc.cards : [];
  if (cards.some((c) => isObj(c) && isString(c.word) && !isString(c.front))) return 0;
  if (cards.length === 0) {
    const decks = Array.isArray(doc.decks) ? doc.decks : [];
    if (decks.some((d) => isObj(d) && d.flag !== undefined && d.icon === undefined)) return 0;
  }
  const settings = doc.settings;
  if (isObj(settings) && typeof settings.ttsEnabled === 'boolean' && settings.readAloudEnabled === undefined) {
    return 0;
  }
  return 1;
}

/**
 * Rule 6 of spec §3.1 for a reader that knows the schemas up to
 * `readerSchema`: the document's version when it is TOO NEW for that reader,
 * else null. Too new = its schema is above `readerSchema` AND its
 * `minReaderVersion` (or, when it has none, its schema: never guess that a
 * newer document is readable) is above it too.
 *
 * `migrate()` asks it with this build's CURRENT_SCHEMA. The rule is the same
 * in every build, so it also says what an OLDER build does with what this
 * build writes: a schema-2 build (v2.1.x / v2.2.x) finds `minReaderVersion` 3
 * and stops ("too new") instead of reading cards that have no text.
 *
 *   tooNewFor({ schemaVersion: 3, minReaderVersion: 3 }, 2) → 3
 *   tooNewFor({ schemaVersion: 9, minReaderVersion: 3 }, 3) → null (we may read it)
 */
export function tooNewFor(doc: Record<string, unknown>, readerSchema: number): number | null {
  const from = detectVersion(doc);
  if (from <= readerSchema) return null;
  const minReader = isCount(doc.minReaderVersion) ? doc.minReaderVersion : from;
  return minReader > readerSchema ? from : null;
}

/**
 * The schema whose SHAPE a readable document has: where its steps start.
 * Its own version, up to this build's. A NEWER document that we may read
 * (`minReaderVersion` ≤ CURRENT_SCHEMA) promises that the readers from
 * `minReaderVersion` on can read it, so it has their shape: a document that
 * a schema-2 reader may read still has the v2 card texts (it goes through
 * v2toV3), one that needs schema 3 has the note model.
 */
function shapeOf(doc: Obj, from: number): number {
  if (from <= CURRENT_SCHEMA) return from;
  const minReader = isCount(doc.minReaderVersion) ? doc.minReaderVersion : from;
  return minReader <= LAST_TEXT_SCHEMA ? LAST_TEXT_SCHEMA : CURRENT_SCHEMA;
}

/* --------------------------------------------------------------- v0 → v2 */

/** The ten language fields of a schema-0 card. They move into `card.legacy`. */
const V0_CARD_KEYS = ['word', 'article', 'base', 'tr', 'ipa', 'ex', 'exTr', 'level', 'type', 'lang'] as const;
/** The schema-0 deck fields with no slot in schema 2. They move into `deck.legacy`. */
const V0_DECK_KEYS = ['flag', 'lang', 'level'] as const;

const FALLBACK_DECK_ICON = '🗂️';

const nonEmpty = (v: unknown): v is string => isString(v) && v.trim() !== '';

/**
 * One schema-0 card → a schema-2 card. Lossless: the ten old fields are copied
 * unchanged into `legacy` (v2toV3 lifts them into note fields), and the
 * learner still SEES the IPA and the example translation in schema 2, in
 * `notes`.
 *
 * `front = word` as it is: v2.0.2's `word` is already the full display form
 * ("die Stunde"), so the article is never added a second time.
 */
function cardFromV0(c: Obj): Obj {
  const legacy: Obj = {};
  const rest: Obj = { ...c };
  for (const key of V0_CARD_KEYS) {
    if (c[key] !== undefined) legacy[key] = c[key];
    delete rest[key];
  }
  const card: Obj = { ...rest, front: c.word, back: c.tr };
  if (nonEmpty(c.ex)) card.example = c.ex;
  const notes = [c.ipa, c.exTr].filter(nonEmpty).join('\n');
  if (notes) card.notes = notes;
  if (Object.keys(legacy).length > 0) card.legacy = legacy as unknown as LegacyCardV0;
  return card;
}

/** One schema-0 deck → a schema-2 deck: `flag` becomes the icon; flag, language and level are kept in `legacy`. */
function deckFromV0(d: Obj): Obj {
  const legacy: Obj = {};
  const rest: Obj = { ...d };
  for (const key of V0_DECK_KEYS) {
    if (d[key] !== undefined) legacy[key] = d[key];
    delete rest[key];
  }
  const icon = nonEmpty(d.icon) ? d.icon : nonEmpty(d.flag) ? d.flag : FALLBACK_DECK_ICON;
  const deck: Obj = { ...rest, icon };
  if (Object.keys(legacy).length > 0) deck.legacy = legacy as LegacyDeckV0;
  return deck;
}

/** The reminder time of the old app (v2.0.x, the German fork, main@1333d48): its default. */
const OLD_APP_REMINDER_TIME = '21:00';

/**
 * The old app's reminder time ('21:00') → today's default ('20:00'), in place
 * (wave 5b L7). No screen of the old app could change that time (spec §7 #8:
 * "never read"), so it was never the learner's choice, and its reminder never
 * worked (it is turned off in the same step). Without this, every screen that
 * offers a reminder — Today's one-time card, Settings › Reminders — would say
 * the old default, "9:00 PM", instead of the spec's "8:00 PM". Any other value
 * is kept as it is.
 */
function moveOldReminderTime(settings: Obj): void {
  if (settings.reminderTime === OLD_APP_REMINDER_TIME) settings.reminderTime = DEFAULT_APP_SETTINGS_V2.reminderTime;
}

/**
 * Schema-0 settings → schema 2:
 *   - `ttsEnabled` → `readAloudEnabled` (the same switch, renamed);
 *   - `autoPlayAudio` → `autoReadAloud` (v2.0.2's "speak on reveal");
 *   - `pronunciationPrompt` stays as an unknown key (no build reads it; removed at v4);
 *   - `reminderEnabled` → false, and the old default time '21:00' → '20:00' (see v1toV2).
 */
function settingsFromV0(s: Obj): Obj {
  const { ttsEnabled, autoPlayAudio, ...rest } = s;
  const out: Obj = { ...rest };
  if (typeof out.readAloudEnabled !== 'boolean' && typeof ttsEnabled === 'boolean') {
    out.readAloudEnabled = ttsEnabled;
  }
  if (typeof out.autoReadAloud !== 'boolean') {
    out.autoReadAloud = typeof autoPlayAudio === 'boolean' ? autoPlayAudio : false;
  }
  out.reminderEnabled = false;
  moveOldReminderTime(out);
  return out;
}

/**
 * Schema 0 → schema 2: the card, deck and settings shapes (see the helpers
 * above). Everything else (person, sessions, review log, collections, the
 * in-flight marker with or without `studyDay`, `deck.builtin`) is kept as it
 * is. `migrate()` then repairs and fills defaults. (`now` is not needed by
 * this step; every step takes it so they all have the same signature.)
 */
export function v0toV2(doc: LegacyV0Doc, now: number): DataStateV2 {
  const cards = doc.cards.map((c) => (isObj(c) && !isString(c.front) ? cardFromV0(c) : c));
  const decks = doc.decks.map((d) => (isObj(d) ? deckFromV0(d) : d));
  return {
    ...doc,
    cards,
    decks,
    settings: settingsFromV0(doc.settings),
    schemaVersion: 2,
    minReaderVersion: 2,
  } as unknown as DataStateV2;
}

/* --------------------------------------------------------------- v1 → v2 */

/**
 * Schema 1 → schema 2: only three settings change. `autoReadAloud` is new (off).
 * `reminderEnabled` becomes false: the old toggle never scheduled anything,
 * and without this the first build with real reminders would schedule
 * notifications (or ask for permission) for every user without asking. The
 * old default time '21:00' becomes '20:00' (`moveOldReminderTime`).
 * (`now` is not needed by this step, like in v0toV2.)
 */
export function v1toV2(doc: LegacyV1Doc, now: number): DataStateV2 {
  const settings: Obj = { ...doc.settings, autoReadAloud: false, reminderEnabled: false };
  moveOldReminderTime(settings);
  return {
    ...doc,
    settings,
    schemaVersion: 2,
    minReaderVersion: 2,
  } as unknown as DataStateV2;
}

/* ------------------------------------------------- repairs (both schemas) */

/**
 * A copy-on-write helper for one stored object: it copies the object only on
 * the first repair (an intact object keeps its identity), and writes each
 * repair to the list as "<label>: <key> <old> → <new>".
 */
function repairer(obj: Obj, label: string, repaired: string[]) {
  let copy: Obj | null = null;
  return {
    set(key: string, value: unknown) {
      repaired.push(`${label}: ${key} ${show(obj[key])} → ${show(value)}`);
      copy = copy ?? { ...obj };
      copy[key] = value;
    },
    /** Set a value WITHOUT a line: for a nested object whose own repairs are already listed. */
    put(key: string, value: unknown) {
      copy = copy ?? { ...obj };
      copy[key] = value;
    },
    remove(key: string) {
      repaired.push(`${label}: ${key} ${show(obj[key])} removed`);
      copy = copy ?? { ...obj };
      delete copy[key];
    },
    get(key: string): unknown {
      return (copy ?? obj)[key];
    },
    result(): Obj {
      return copy ?? obj;
    },
  };
}
type Repairer = ReturnType<typeof repairer>;

/** The starting ease of the document's own settings (a broken one → the default). */
function startingEaseOf(raw: Obj): number {
  const srs = isObj(raw.settings) && isObj(raw.settings.srs) ? raw.settings.srs : {};
  return isFiniteNum(srs.startingEase) && srs.startingEase >= MIN_EASE ? srs.startingEase : DEFAULT_SRS.startingEase;
}

/**
 * The flags and the schedule of a card — the keys that schema 2 and schema 3
 * share. A bad number must never reach the SM-2 math (NaN due dates):
 *   - `fav`, `flagged`, `suspended` that are not true/false → false (true stays true);
 *   - `buriedUntil` that is not null and not a finite number → null;
 *   - `ease`: not finite → the starting ease; below 1.3 → 1.3;
 *   - `intervalDays`: not finite or negative → 0;
 *   - `reps`, `lapses`: not finite or negative → 0; a fraction → rounded down;
 *   - `stepIndex`: not null and not a whole number ≥ 0 → 0 when the card was
 *     studied (it stays in learning; srs.ts clamps the range), else null;
 *   - `due`, `createdAt`: not finite → now; `lastReviewedAt`: not null and not finite → null.
 */
function repairSchedule(raw: Obj, r: Repairer, ctx: { now: number; startingEase: number }): void {
  for (const key of ['fav', 'flagged', 'suspended']) {
    const v = raw[key];
    if (v !== undefined && typeof v !== 'boolean') r.set(key, v === true);
  }
  if (raw.buriedUntil !== undefined && raw.buriedUntil !== null && !isFiniteNum(raw.buriedUntil)) {
    r.set('buriedUntil', null);
  }
  if (!isFiniteNum(raw.ease)) r.set('ease', ctx.startingEase);
  else if (raw.ease < MIN_EASE) r.set('ease', MIN_EASE);
  if (!isFiniteNum(raw.intervalDays) || raw.intervalDays < 0) r.set('intervalDays', 0);
  for (const key of ['reps', 'lapses']) {
    const v = raw[key];
    if (!isFiniteNum(v) || v < 0) r.set(key, 0);
    else if (!Number.isInteger(v)) r.set(key, Math.floor(v));
  }
  const step = raw.stepIndex;
  if (step !== null && !isCount(step)) {
    r.set('stepIndex', (r.get('reps') as number) > 0 ? 0 : null);
  }
  if (!isFiniteNum(raw.due)) r.set('due', ctx.now);
  if (!isFiniteNum(raw.createdAt)) r.set('createdAt', ctx.now);
  if (raw.lastReviewedAt !== null && !isFiniteNum(raw.lastReviewedAt)) r.set('lastReviewedAt', null);
}

/** A local calendar day, as `dayKeyOf()` writes it: '2026-07-15'. */
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
/** The four rating counters of a session marker. */
const MARKER_COUNTS = ['again', 'hard', 'good', 'easy'] as const;
/** The other numbers of a session marker. `total` is separate: it can be rebuilt from the counts. */
const MARKER_NUMBERS = ['bestRun', 'durationSec', 'fastAnswers'] as const;

/**
 * Every session kind this schema knows (`SessionKind`, v3: with 'practice').
 * It is a record, not a list, so TypeScript checks that it has EXACTLY the
 * values of the type: when a new kind is added to `SessionKind`, this line no
 * longer compiles until the kind is added here too.
 */
const SESSION_KINDS: Readonly<Record<SessionKind, true>> = {
  scheduled: true,
  ahead: true,
  practice: true,
  cram: true,
  hardest: true,
  deck: true,
  collection: true,
};

/** True for a text that is one of the SessionKind values ('scheduled', 'cram' …). */
function isSessionKind(v: unknown): v is SessionKind {
  // hasOwnProperty, not `in`: 'constructor' or 'toString' must not count as a kind.
  return isString(v) && Object.prototype.hasOwnProperty.call(SESSION_KINDS, v);
}

/**
 * Every study mode (`StudyMode`, the marker's optional `mode`, wave 5h). A
 * record for the same reason as SESSION_KINDS: a new mode in the type does
 * not compile until it is added here too.
 */
const MARKER_MODES: Readonly<Record<StudyMode, true>> = {
  flash: true,
  type: true,
  mc: true,
  mix: true,
  article: true,
};

/** True for a text that is one of the StudyMode values ('flash', 'mc' …). */
function isMarkerMode(v: unknown): v is StudyMode {
  return isString(v) && Object.prototype.hasOwnProperty.call(MARKER_MODES, v);
}

/**
 * Repair a whole number ≥ 0 in place: not a finite number, or negative → 0;
 * a fraction → rounded down. (The session screen always stores whole numbers.)
 */
function repairCounter(r: Repairer, key: string, v: unknown): void {
  if (!isFiniteNum(v) || v < 0) r.set(key, 0);
  else if (!Number.isInteger(v)) r.set(key, Math.floor(v));
}

/**
 * The in-flight session marker (M5), repaired FIELD BY FIELD so the boot
 * reconcile can still bank the session. Before, one bad number removed the
 * whole marker, and the learner lost the XP and the streak day of a session
 * whose cards were already rated.
 *
 *   - `kind` that is not one of the SessionKind values (not a text, or an
 *     unknown text like 'foo') → 'scheduled'. The boot reconcile writes the
 *     kind into a SessionRecord, so an unknown kind must never get there;
 *   - `label` not a text → '' (the boot reconcile is silent, so the label is
 *     never shown);
 *   - a rating counter that is not a whole number ≥ 0 → 0 (a fraction → rounded down);
 *   - `total` not a whole number ≥ 0 → the sum of the four counters;
 *   - `total` that does not match the counters → the sum of the counters, when
 *     that sum is above 0. session.tsx always saves total === the sum (one
 *     counter per rating), so a different total is damage, and the counters
 *     say what was really studied. Example: counts {good: 2}, total 0 → total 2.
 *     (When the sum is 0 but the total is a whole number above 0, the
 *     COUNTERS are the damaged part, so the total is kept: the reviews happened.)
 *   - `bestRun`, `durationSec`, `fastAnswers` not a whole number ≥ 0 → 0;
 *   - `studyDay` that is not a day key like '2026-07-15' → removed
 *     (`attributionDay()` then uses the completion day, like for old markers).
 *   - `mode` (wave 5h) that is not one of the StudyMode values → removed
 *     (the record then has no mode, like the record of an older marker). A
 *     valid mode is kept. A marker without `mode` (saved before wave 5h)
 *     needs no repair.
 *
 * Returns null (the marker is removed, with one line) when it cannot be used:
 *   - it is not an object, or it has no `counts` object (we do not know what
 *     was studied);
 *   - after the repairs it records NO reviews: `total` is 0 and the four
 *     counters are 0 (for example `counts: {}` with `total: 'x'`). The app
 *     never saves such a marker: session.tsx clears it when an undo goes
 *     back to zero reviews, so the boot reconcile cannot bank reviews that
 *     did not happen (#4). Banking it would give XP and a streak day for
 *     nothing.
 */
function sanitizeMarker(m: unknown, repaired: string[]): unknown {
  const label = 'inProgressSession';
  if (!isObj(m) || !isObj(m.counts)) {
    repaired.push(`${label}: ${show(m)} is not a valid session marker, removed`);
    return null;
  }
  // The field repairs go to a list of their own first. When the marker is
  // removed at the end, its one line replaces them.
  const lines: string[] = [];
  const r = repairer(m, label, lines);
  if (!isSessionKind(m.kind)) r.set('kind', 'scheduled');
  if (!isString(m.label)) r.set('label', '');

  const counts = repairer(m.counts, `${label}.counts`, lines);
  for (const key of MARKER_COUNTS) repairCounter(counts, key, m.counts[key]);
  const fixedCounts = counts.result();
  if (fixedCounts !== m.counts) r.put('counts', fixedCounts);
  const countSum = MARKER_COUNTS.reduce((sum, key) => sum + (fixedCounts[key] as number), 0);

  // A counter that had to be repaired was damaged, so it may have lost
  // reviews. Then a valid stored total that is HIGHER than the repaired sum
  // is kept: those reviews happened, and cutting the total would lose XP.
  const rawCounts = m.counts as Record<string, unknown>;
  const counterDamaged = MARKER_COUNTS.some((key) => fixedCounts[key] !== rawCounts[key]);
  // One `set` at most, so the list has one line for the total.
  if (!isCount(m.total)) r.set('total', countSum);
  else if (countSum > 0 && m.total !== countSum && !(counterDamaged && m.total > countSum)) {
    r.set('total', countSum);
  }
  if (r.get('total') === 0 && countSum === 0) {
    repaired.push(`${label}: ${show(m)} records no reviews, removed`);
    return null;
  }
  for (const key of MARKER_NUMBERS) repairCounter(r, key, m[key]);
  if (m.studyDay !== undefined && !(isString(m.studyDay) && DAY_KEY.test(m.studyDay))) r.remove('studyDay');
  if (m.mode !== undefined && !isMarkerMode(m.mode)) r.remove('mode');
  repaired.push(...lines);
  return r.result();
}

/** The marker after sanitizeMarker, or the stored value when there is none. */
function markerOf(raw: Obj, repaired: string[]): unknown {
  const m = raw.inProgressSession;
  return m === undefined || m === null ? m : sanitizeMarker(m, repaired);
}

/** Keep the original list when nothing in it changed (so an intact list keeps its identity). */
const sameList = (list: unknown, next: readonly unknown[]) =>
  Array.isArray(list) && list.length === next.length && list.every((x, i) => x === next[i]);

/* ------------------------------------------------------------- sanitize v2 */

function sanitizeDeckV2(raw: Obj, index: number, now: number, repaired: string[]): Obj {
  const label = `deck ${isString(raw.id) ? JSON.stringify(raw.id) : `#${index}`}`;
  const r = repairer(raw, label, repaired);
  if (!isString(raw.id) || raw.id === '') r.set('id', `deck-repaired-${index}`);
  if (!isString(raw.name)) r.set('name', String(raw.name ?? ''));
  if (!isString(raw.icon)) r.set('icon', FALLBACK_DECK_ICON);
  if (typeof raw.builtin !== 'boolean') r.set('builtin', false);
  if (typeof raw.active !== 'boolean') r.set('active', true);
  if (!isFiniteNum(raw.createdAt)) r.set('createdAt', now);
  if (raw.desc !== undefined && !isString(raw.desc)) r.remove('desc');
  return r.result();
}

function sanitizeCardV2(
  raw: Obj,
  index: number,
  ctx: { now: number; startingEase: number; deckIds: Set<string> },
  repaired: string[],
): Obj {
  const label = `card ${isString(raw.id) ? JSON.stringify(raw.id) : `#${index}`}`;
  const r = repairer(raw, label, repaired);
  if (!isString(raw.id) || raw.id === '') r.set('id', `card-repaired-${index}`);

  // Texts: a card must always have a text front and back.
  for (const key of ['front', 'back']) {
    if (!isString(raw[key])) r.set(key, String(raw[key] ?? ''));
  }
  for (const key of ['example', 'notes']) {
    const v = raw[key];
    if (v === undefined || isString(v)) continue;
    if (v === null) r.remove(key);
    else r.set(key, String(v));
  }
  // Tags that are not a list of texts KEEP what they hold, as texts (the same
  // rule as checkIntegrity for v3 notes): ['ok', 3] → ['ok', '3'].
  if (raw.tags !== undefined && !(Array.isArray(raw.tags) && raw.tags.every(isString))) {
    r.set('tags', tagsFrom(raw.tags));
  }
  repairSchedule(raw, r, ctx);

  // No-orphan: a card always belongs to a deck that exists.
  if (!isString(raw.deckId) || !ctx.deckIds.has(raw.deckId)) r.set('deckId', UNFILED_DECK_ID);
  return r.result();
}

/**
 * Repair, never drop (spec §3.3) — a SCHEMA-2 document, before v2toV3.
 * Returns the repaired state and one readable line per repair. An intact
 * document comes back with the SAME card and deck objects and an empty list.
 *
 *   - card texts: a non-text `front`/`back` → `String(x ?? '')`;
 *   - tags that are not a list of texts → the texts they hold (tagsFrom);
 *   - the flags and the schedule: see repairSchedule;
 *   - a card whose deck does not exist → the "Unfiled cards" deck (created
 *     when needed) — the no-orphan invariant;
 *   - deck fields of the wrong type → the defaults of `addDeck`;
 *   - the in-flight marker: each bad field is repaired (see sanitizeMarker);
 *     it is removed only when it has no `counts` at all, or when it records
 *     no reviews.
 * Entries that are not objects at all (e.g. `null` in the card list) cannot be
 * repaired and are removed (and listed).
 */
export function sanitizeV2(s: DataStateV2, now: number): { state: DataStateV2; repaired: string[] } {
  const repaired: string[] = [];
  const raw = s as unknown as Obj;
  const startingEase = startingEaseOf(raw);

  // Decks first: the card repairs need the ids of the decks that exist.
  const decks: Obj[] = [];
  (Array.isArray(raw.decks) ? raw.decks : []).forEach((d, i) => {
    if (isObj(d)) decks.push(sanitizeDeckV2(d, i, now, repaired));
    else repaired.push(`deck #${i}: ${show(d)} is not a deck, removed`);
  });
  const deckIds = new Set(decks.map((d) => d.id as string));

  const cards: Obj[] = [];
  (Array.isArray(raw.cards) ? raw.cards : []).forEach((c, i) => {
    if (isObj(c)) cards.push(sanitizeCardV2(c, i, { now, startingEase, deckIds }, repaired));
    else repaired.push(`card #${i}: ${show(c)} is not a card, removed`);
  });
  if (cards.some((c) => c.deckId === UNFILED_DECK_ID) && !deckIds.has(UNFILED_DECK_ID)) {
    decks.push(unfiledDeckV2(now) as unknown as Obj);
    repaired.push(`deck "${UNFILED_DECK_ID}": created for cards whose deck was missing`);
  }

  const inProgressSession = markerOf(raw, repaired);
  const state = {
    ...s,
    decks: sameList(raw.decks, decks) ? raw.decks : decks,
    cards: sameList(raw.cards, cards) ? raw.cards : cards,
    ...(inProgressSession !== raw.inProgressSession ? { inProgressSession } : {}),
  } as unknown as DataStateV2;
  return { state, repaired };
}

/* ------------------------------------------------------------- sanitize v3 */

/** Every SourceKind (a record, so TypeScript checks that the list is complete). */
const SOURCE_KINDS: Readonly<Record<SourceKind, true>> = {
  manual: true,
  csv: true,
  apkg: true,
  ankiweb: true,
  pack: true,
  migrated: true,
  backup: true,
};
const isSourceKind = (v: unknown): v is SourceKind =>
  isString(v) && Object.prototype.hasOwnProperty.call(SOURCE_KINDS, v);

/** The two new-card states a card may store (absent = 'queued'). */
const NEW_STATES: readonly unknown[] = ['queued', 'notStarted'];
/** Anki's flag colours (1 red … 7 purple). */
const isFlagColor = (v: unknown): boolean => isCount(v) && v >= 1 && v <= 7;

/**
 * The v3-only keys of a card (spec §3.4), after the shared repairSchedule:
 *   - `newState` that is not 'queued' or 'notStarted' → removed (absent = 'queued', a New card);
 *   - `newPos` (its place in the new-card feed) not finite → the order of its
 *     note (siblings share it), or its createdAt when the note has none;
 *   - `knownAt`, `knownCheckedAt` that are not null and not finite → null;
 *   - `flagColor` that is not an Anki colour 1–7 → removed.
 * Its id, note, deck and direction are checked by checkIntegrity (it runs first).
 */
function sanitizeCardV3(
  raw: Obj,
  ctx: { now: number; startingEase: number; noteOrder: ReadonlyMap<string, number> },
  repaired: string[],
): Obj {
  const r = repairer(raw, `card ${JSON.stringify(String(raw.id))}`, repaired);
  repairSchedule(raw, r, ctx);
  if (raw.newState !== undefined && !NEW_STATES.includes(raw.newState)) r.remove('newState');
  if (!isFiniteNum(raw.newPos)) {
    const order = isString(raw.noteId) ? ctx.noteOrder.get(raw.noteId) : undefined;
    r.set('newPos', order ?? r.get('createdAt'));
  }
  for (const key of ['knownAt', 'knownCheckedAt']) {
    const v = raw[key];
    if (v !== undefined && v !== null && !isFiniteNum(v)) r.set(key, null);
  }
  if (raw.flagColor !== undefined && !isFlagColor(raw.flagColor)) r.remove('flagColor');
  return r.result();
}

/** The default options of a deck (makeV3 DEFAULT_DECK_OPTIONS), written out for the repairs. */
const OPTION_DEFAULTS = { newPerDay: null, newOrder: 'source', newArrival: 'queued', knownChecks: true } as const;

/**
 * The options of a v3 deck: each scalar option the scheduler reads, repaired
 * to its default (the `directions` map is repaired by checkIntegrity):
 *   - `newPerDay`: not null and not a whole number ≥ 0 → null (only the global limit);
 *   - `newOrder`: not 'source' or 'random' → 'source';
 *   - `newArrival`: not 'queued' or 'notStarted' → 'queued';
 *   - `knownChecks`: not true/false → true.
 * `options` that is not an object → the default options.
 *
 * A key that is only MISSING gets its default WITHOUT a repair line (the
 * same rule as `reporter`): a deck saved by a build that did not have that
 * option yet is not damaged. Only a stored value of the wrong kind is
 * listed, so "We fixed {n} items" counts real repairs only.
 *
 *   { newPerDay: -2 }  → newPerDay null, listed; the three missing keys filled, not listed
 */
function sanitizeDeckOptions(options: unknown, label: string, repaired: string[]): unknown {
  if (!isObj(options)) {
    repaired.push(`${label}: options ${show(options)} → the default options`);
    return { ...OPTION_DEFAULTS };
  }
  const r = repairer(options, `${label}.options`, repaired);
  /** Missing → the default, no line; present but `ok` is false → the default, listed. */
  const fix = (key: keyof typeof OPTION_DEFAULTS, ok: boolean) => {
    if (options[key] === undefined) r.put(key, OPTION_DEFAULTS[key]);
    else if (!ok) r.set(key, OPTION_DEFAULTS[key]);
  };
  fix('newPerDay', options.newPerDay === null || isCount(options.newPerDay));
  fix('newOrder', options.newOrder === 'source' || options.newOrder === 'random');
  fix('newArrival', options.newArrival === 'queued' || options.newArrival === 'notStarted');
  fix('knownChecks', isBool(options.knownChecks));
  return r.result();
}

/** The optional text keys of a v3 deck. A value that is not a text is removed. */
const DECK_TEXT_KEYS = ['desc', 'sourceKey', 'language', 'meaningLanguage', 'defaultTypeId'] as const;

/**
 * One v3 deck: the shape the screens and the scheduler read.
 *   - `name` not a text → its text; `icon` not a text → 🗂️;
 *   - `active` not true/false → true; `createdAt` not finite → now;
 *   - `order` not finite → after the last deck (`nextOrder`);
 *   - `source` that is not a SourceKind → 'manual';
 *   - `builtin`, `genderColors` that are not true/false → removed (both are optional);
 *   - `desc`, `sourceKey`, `language`, `meaningLanguage`, `defaultTypeId` not a text → removed;
 *   - `options`: see sanitizeDeckOptions.
 * Its id is checked by checkIntegrity (it runs first).
 */
function sanitizeDeckV3(raw: Obj, ctx: { now: number; nextOrder: () => number }, repaired: string[]): Obj {
  const label = `deck ${JSON.stringify(String(raw.id))}`;
  const r = repairer(raw, label, repaired);
  if (!isString(raw.name)) r.set('name', String(raw.name ?? ''));
  if (!isString(raw.icon)) r.set('icon', FALLBACK_DECK_ICON);
  if (!isBool(raw.active)) r.set('active', true);
  if (!isFiniteNum(raw.createdAt)) r.set('createdAt', ctx.now);
  if (!isFiniteNum(raw.order)) r.set('order', ctx.nextOrder());
  if (!isSourceKind(raw.source)) r.set('source', 'manual');
  for (const key of ['builtin', 'genderColors']) {
    if (raw[key] !== undefined && !isBool(raw[key])) r.remove(key);
  }
  for (const key of DECK_TEXT_KEYS) {
    if (raw[key] !== undefined && !isString(raw[key])) r.remove(key);
  }
  const options = sanitizeDeckOptions(raw.options, label, repaired);
  if (options !== raw.options) r.put('options', options);
  return r.result();
}

/**
 * One v3 note: the keys checkIntegrity does not read.
 *   - `createdAt` not finite → now; `updatedAt` not finite → createdAt;
 *   - `order` (its source order) not finite → createdAt;
 *   - `source` that is not `{ kind: <SourceKind> }` → { kind: 'manual' } (other keys kept).
 */
function sanitizeNoteV3(raw: Obj, now: number, repaired: string[]): Obj {
  const r = repairer(raw, `note ${JSON.stringify(String(raw.id))}`, repaired);
  if (!isFiniteNum(raw.createdAt)) r.set('createdAt', now);
  if (!isFiniteNum(raw.updatedAt)) r.set('updatedAt', r.get('createdAt'));
  if (!isFiniteNum(raw.order)) r.set('order', r.get('createdAt'));
  if (!(isObj(raw.source) && isSourceKind(raw.source.kind))) {
    r.set('source', { ...(isObj(raw.source) ? raw.source : {}), kind: 'manual' });
  }
  return r.result();
}

/**
 * Repair, never drop — a SCHEMA-3 document (the note model). It runs after
 * checkIntegrity, which already made every LINK right (ids, notes, card
 * types, decks, directions). This step repairs the VALUES:
 *   - cards: the flags and the schedule (repairSchedule) and the v3 keys (sanitizeCardV3);
 *   - decks: names, order, source and options (sanitizeDeckV3);
 *   - notes: times, order and source (sanitizeNoteV3);
 *   - the in-flight marker (sanitizeMarker).
 * An intact document comes back with the SAME lists and an empty repair list
 * (an object that needs no repair keeps its identity).
 *
 * Example: `sanitize(state, now).repaired` → ['card "c1": ease null → 2.5'].
 */
export function sanitize(s: DataState, now: number): { state: DataState; repaired: string[] } {
  const repaired: string[] = [];
  const raw = s as unknown as Obj;
  const startingEase = startingEaseOf(raw);
  const list = (key: string): unknown[] => (Array.isArray(raw[key]) ? (raw[key] as unknown[]) : []);

  const notes = list('notes').map((n) => (isObj(n) ? sanitizeNoteV3(n, now, repaired) : n));
  const noteOrder = new Map<string, number>();
  for (const n of notes) {
    if (isObj(n) && isString(n.id) && isFiniteNum(n.order) && !noteOrder.has(n.id)) noteOrder.set(n.id, n.order);
  }
  const cards = list('cards').map((c) =>
    isObj(c) ? sanitizeCardV3(c, { now, startingEase, noteOrder }, repaired) : c,
  );

  // A deck with a broken order goes after the last deck with a real one.
  let maxOrder = -1;
  for (const d of list('decks')) if (isObj(d) && isFiniteNum(d.order)) maxOrder = Math.max(maxOrder, d.order);
  const nextOrder = () => (maxOrder += 1);
  const decks = list('decks').map((d) => (isObj(d) ? sanitizeDeckV3(d, { now, nextOrder }, repaired) : d));

  const inProgressSession = markerOf(raw, repaired);
  const changed = (key: string, next: unknown[]) => (Array.isArray(raw[key]) && !sameList(raw[key], next) ? { [key]: next } : {});
  const state = {
    ...s,
    ...changed('notes', notes),
    ...changed('cards', cards),
    ...changed('decks', decks),
    ...(inProgressSession !== raw.inProgressSession ? { inProgressSession } : {}),
  } as unknown as DataState;
  return { state, repaired };
}

/* ---------------------------------------------------------- mergeDefaults */

/** True when `value` can stand where the default `def` stands (same kind of value). */
function sameKind(value: unknown, def: unknown): boolean {
  if (typeof def === 'number') return isFiniteNum(value);
  if (Array.isArray(def)) return Array.isArray(value);
  return value !== null && typeof value === typeof def;
}

/** Lists one default that replaced the value `old` (see `reporter`). */
type Report = (where: string, old: unknown, value: unknown) => void;

/**
 * Writes one line to the repair list when mergeDefaults REPLACES a stored
 * value: `report('settings: sessionLimit', null, 50)` →
 * "settings: sessionLimit null → 50".
 *
 * A key that is simply MISSING (`undefined`) gets its default without a
 * line: an older build did not have that key, so nothing was damaged. A
 * stored value of the wrong kind (a JSON `null` where a number belongs is
 * how a NaN was saved) was damaged, so it is listed.
 */
function reporter(repaired: string[]): Report {
  return (where, old, value) => {
    if (old !== undefined) repaired.push(`${where} ${show(old)} → ${show(value)}`);
  };
}

/** A stored value that should be an object but is not: listed, then the defaults are used. */
function reportNotObject(raw: unknown, where: string, repaired: string[]): void {
  if (raw !== undefined && !isObj(raw)) repaired.push(`${where} ${show(raw)} is not an object, defaults used`);
}

function mergeSrs(raw: unknown, report: Report, repaired: string[]): SrsSettings {
  reportNotObject(raw, 'settings: srs', repaired);
  const stored = isObj(raw) ? raw : {};
  const out: Obj = { ...stored };
  for (const [key, def] of Object.entries(DEFAULT_SRS)) {
    const v = stored[key];
    if (key === 'learningStepsMin') {
      const ok = Array.isArray(v) && v.every((m) => isFiniteNum(m) && m > 0);
      if (!ok) {
        out[key] = [...DEFAULT_SRS.learningStepsMin];
        report(`settings.srs: ${key}`, v, out[key]);
      }
    } else if (!sameKind(v, def)) {
      out[key] = def;
      report(`settings.srs: ${key}`, v, def);
    }
  }
  return out as unknown as SrsSettings;
}

/**
 * Settings keys whose value needs more than "the same kind as the default":
 *   - `studyMode`: one of the four modes of the settings;
 *   - `knownChecksPerDay` (v3): a whole number ≥ 0;
 *   - `lastAutoBackupAt` (v3): null (never) or a time — its default is null,
 *     so "the same kind" cannot tell.
 */
const SETTING_CHECKS: Readonly<Record<string, (v: unknown) => boolean>> = {
  studyMode: (v) => v === 'flash' || v === 'type' || v === 'mc' || v === 'mix',
  knownChecksPerDay: isCount,
  lastAutoBackupAt: (v) => v === null || isFiniteNum(v),
};

/** `settings` over `defaults` (v2 or v3), and `settings.srs` over DEFAULT_SRS. Unknown keys are kept. */
function mergeSettings(raw: unknown, defaults: Obj, report: Report, repaired: string[]): Obj {
  reportNotObject(raw, 'settings:', repaired);
  const stored = isObj(raw) ? raw : {};
  const out: Obj = { ...stored };
  for (const [key, def] of Object.entries(defaults)) {
    if (key === 'srs') continue;
    const check = SETTING_CHECKS[key];
    if (!(check ? check(stored[key]) : sameKind(stored[key], def))) {
      out[key] = def;
      report(`settings: ${key}`, stored[key], def);
    }
  }
  out.srs = mergeSrs(stored.srs, report, repaired);
  return out;
}

const PERSON_NUMBERS = ['xp', 'streak', 'bestStreak', 'freezes', 'goalReviews', 'goalNew', 'fastAnswers'] as const;

/** The v2 day tally (`reviews`, `neww`) over a zero day. */
function mergeDayDoneV2(raw: unknown, zero: DayDoneV2, report: Report, repaired: string[]): Obj {
  reportNotObject(raw, 'person: dayDone', repaired);
  const stored = isObj(raw) ? raw : {};
  const out: Obj = { ...zero, ...stored };
  if (!isString(stored.dayKey)) {
    out.dayKey = zero.dayKey;
    report('person.dayDone: dayKey', stored.dayKey, zero.dayKey);
  }
  for (const key of ['reviews', 'neww'] as const) {
    if (!isCount(stored[key])) {
      out[key] = 0;
      report(`person.dayDone: ${key}`, stored[key], 0);
    }
  }
  return out;
}

/**
 * The v3 day tally: the v2 counters plus `checks` (a whole number ≥ 0) and
 * `newByDeck` (deck id → a whole number ≥ 0). In `newByDeck`, an entry that
 * is not a count is removed (it counts as 0 anyway). It is rebuilt with
 * Object.fromEntries, which keeps every deck id as a key (a spread would run
 * the `__proto__` setter for a deck id "__proto__").
 */
function mergeDayDone(raw: unknown, zero: DayDone, report: Report, repaired: string[]): DayDone {
  const out = mergeDayDoneV2(raw, zero, report, repaired);
  const stored = isObj(raw) ? raw : {};
  if (!isCount(stored.checks)) {
    out.checks = 0;
    report('person.dayDone: checks', stored.checks, 0);
  }
  const byDeck = stored.newByDeck;
  if (!(isObj(byDeck) && Object.values(byDeck).every(isCount))) {
    out.newByDeck = isObj(byDeck) ? Object.fromEntries(Object.entries(byDeck).filter(([, n]) => isCount(n))) : {};
    report('person.dayDone: newByDeck', byDeck, out.newByDeck);
  }
  return out as unknown as DayDone;
}

/** The person over `base` (the seed person). The day tally is merged by `dayDone`. */
function mergePersonWith(
  raw: unknown,
  base: Omit<Person, 'dayDone'>,
  dayDone: (raw: unknown) => Obj | DayDone,
  report: Report,
  repaired: string[],
): Obj {
  reportNotObject(raw, 'person:', repaired);
  const stored = isObj(raw) ? raw : {};
  const out: Obj = { ...stored };
  for (const key of PERSON_NUMBERS) {
    const v = stored[key];
    if (!isFiniteNum(v) || v < 0) {
      out[key] = base[key];
      report(`person: ${key}`, v, base[key]);
    }
  }
  const days = stored.freezeUsedDays;
  if (!(Array.isArray(days) && days.every(isString))) {
    out.freezeUsedDays = Array.isArray(days) ? days.filter(isString) : [];
    report('person: freezeUsedDays', days, out.freezeUsedDays);
  }
  if (stored.lastStudyDay !== null && !isString(stored.lastStudyDay)) {
    out.lastStudyDay = base.lastStudyDay;
    report('person: lastStudyDay', stored.lastStudyDay, base.lastStudyDay);
  }
  out.dayDone = dayDone(stored.dayDone);
  const achievements = stored.achievements;
  if (!(isObj(achievements) && Object.values(achievements).every(isFiniteNum))) {
    out.achievements = isObj(achievements)
      ? Object.fromEntries(Object.entries(achievements).filter(([, at]) => isFiniteNum(at)))
      : {};
    report('person: achievements', achievements, out.achievements);
  }
  return out;
}

/** The keys of the v3 state that hold a list. */
type ListKey = {
  [K in keyof DataState]: DataState[K] extends readonly unknown[] ? K : never;
}[keyof DataState];

/** A stored list, or `[]` (listed when a stored value was not a list). */
function listOf<T>(raw: Obj, key: string, report: Report): T[] {
  const v = raw[key];
  if (Array.isArray(v)) return v as T[];
  report(`${key}:`, v, []);
  return [];
}

/**
 * Fill every missing or wrong-typed field of a SCHEMA-2 document with its
 * default (the v2 settings, the seed person with a v2 day tally). See
 * mergeDefaults for the rules; this one runs before v2toV3.
 */
export function mergeDefaultsV2(s: DataStateV2, now: number, repaired: string[] = []): DataStateV2 {
  const seedPerson = buildSeedState(now).person;
  const zero: DayDoneV2 = { dayKey: seedPerson.dayDone.dayKey, reviews: 0, neww: 0 };
  const raw = s as unknown as Obj;
  const report = reporter(repaired);
  const cards = listOf<CardV2>(raw, 'cards', report);
  const decks = listOf<DeckV2>(raw, 'decks', report);
  const collections = listOf<DataStateV2['collections'][number]>(raw, 'collections', report);
  const sessions = listOf<DataStateV2['sessions'][number]>(raw, 'sessions', report);
  const reviewLog = listOf<DataStateV2['reviewLog'][number]>(raw, 'reviewLog', report);
  if (raw.onboarded !== undefined && typeof raw.onboarded !== 'boolean') {
    report('onboarded:', raw.onboarded, cards.length > 0);
  }
  return {
    ...s,
    cards,
    decks,
    collections,
    sessions,
    reviewLog,
    settings: mergeSettings(raw.settings, { ...DEFAULT_APP_SETTINGS_V2 }, report, repaired) as unknown as AppSettingsV2,
    person: mergePersonWith(
      raw.person,
      seedPerson,
      (d) => mergeDayDoneV2(d, zero, report, repaired),
      report,
      repaired,
    ) as unknown as PersonV2,
    onboarded: typeof raw.onboarded === 'boolean' ? raw.onboarded : cards.length > 0,
    inProgressSession: s.inProgressSession ?? null,
  };
}

/**
 * The list preferences (spec §4.7: pinned, hidden, order per list id).
 * `listPrefs` that is not an object → {}; an entry that is not an object →
 * removed; `pinned` / `hidden` not true/false → false; `order` not finite → 0.
 * Rebuilt with Object.fromEntries, so every list id stays a key.
 */
function mergeListPrefs(raw: unknown, report: Report, repaired: string[]): DataState['listPrefs'] {
  if (raw === undefined) return {};
  if (!isObj(raw)) {
    report('listPrefs:', raw, {});
    return {};
  }
  let changed = false;
  const entries: [string, unknown][] = [];
  for (const [id, pref] of Object.entries(raw)) {
    if (!isObj(pref)) {
      repaired.push(`listPrefs: "${id}" ${show(pref)} is not a list preference, removed`);
      changed = true;
      continue;
    }
    const r = repairer(pref, `listPrefs."${id}"`, repaired);
    for (const key of ['pinned', 'hidden']) if (!isBool(pref[key])) r.set(key, false);
    if (!isFiniteNum(pref.order)) r.set('order', 0);
    const fixed = r.result();
    if (fixed !== pref) changed = true;
    entries.push([id, fixed]);
  }
  return (changed ? Object.fromEntries(entries) : raw) as DataState['listPrefs'];
}

/**
 * Every `SortSpec.by` (a record, so TypeScript checks that the list is complete).
 * hasOwnProperty, not `in`: 'constructor' must not count as a sort.
 */
const SORT_BYS: Readonly<Record<SortSpec['by'], true>> = {
  source: true,
  due: true,
  az: true,
  newest: true,
  hardest: true,
  field: true,
};
const isSortSpec = (v: unknown): boolean =>
  isObj(v) && isString(v.by) && Object.prototype.hasOwnProperty.call(SORT_BYS, v.by);

/**
 * The user's saved lists (spec §4.7) — the shape `listsById`, query.ts and
 * the Library read. An entry that is not an object → removed (listed). In a
 * list (each repair listed, the same rules as a deck):
 *   - `id` that is not a non-empty text → 'list-repaired-<index>';
 *   - `name` not a text → its text; `icon` not a text → 🔖 (DEFAULT_LIST_ICON);
 *   - `query` that is not an object → {} (the list then shows every card, so
 *     the learner can see it, fix it or delete it: its name is kept);
 *   - `sort` that is not a SortSpec with a known `by` → removed (the default sort);
 *   - `createdAt` not finite → now; `updatedAt` not finite → createdAt.
 * An intact list keeps its identity, and so does an intact list of lists.
 *
 * WHY: `listsById` reads `list.id` of every entry for every filter, so one
 * `null` in the stored lists broke search on every screen.
 *
 *   [null, { name: 'Verbs', query: { tags: ['verb'] }, … }]
 *     → [{ id: 'list-repaired-1', name: 'Verbs', query: { tags: ['verb'] }, … }]
 */
function mergeLists(list: DataState['lists'], now: number, repaired: string[]): DataState['lists'] {
  const out: Obj[] = [];
  (list as unknown[]).forEach((l, i) => {
    if (!isObj(l)) {
      repaired.push(`list #${i}: ${show(l)} is not a saved list, removed`);
      return;
    }
    const r = repairer(l, `list ${isId(l.id) ? JSON.stringify(l.id) : `#${i}`}`, repaired);
    if (!isId(l.id)) r.set('id', `list-repaired-${i}`);
    if (!isString(l.name)) r.set('name', String(l.name ?? ''));
    if (!isString(l.icon)) r.set('icon', DEFAULT_LIST_ICON);
    if (!isObj(l.query)) r.set('query', {});
    if (l.sort !== undefined && !isSortSpec(l.sort)) r.remove('sort');
    if (!isFiniteNum(l.createdAt)) r.set('createdAt', now);
    if (!isFiniteNum(l.updatedAt)) r.set('updatedAt', r.get('createdAt'));
    out.push(r.result());
  });
  return (sameList(list, out) ? list : out) as unknown as DataState['lists'];
}

/** A card entry of a ManualEdit that undo can read: an id, and `before` / `after` objects. */
const isCardSnapshot = (v: unknown): boolean => isObj(v) && isId(v.id) && isObj(v.before) && isObj(v.after);

/** One side of a note entry: `tags` is a list of texts, `section` is missing or a text. */
const isNoteSide = (v: unknown): boolean =>
  isObj(v) && Array.isArray(v.tags) && v.tags.every(isString) && (v.section === undefined || isString(v.section));

/** A note entry of a ManualEdit that undo can read: an id, and a readable `before` and `after`. */
const isNoteSnapshot = (v: unknown): boolean => isObj(v) && isId(v.id) && isNoteSide(v.before) && isNoteSide(v.after);

/**
 * The manual-edit log (spec §3.4 `ManualEdit`: the undo of edits made outside
 * a review), in the shape `pushManualEdit` and `undoManualEdit` read. Each
 * repair is listed:
 *   - an entry that is not an object, has no usable `id` (undo finds an edit
 *     by its id) or whose `cards` is not a list → removed;
 *   - a card entry that is not `{ id, before: {…}, after: {…} }` → removed;
 *   - `notes` that is not a list → removed; a note entry that is not
 *     `{ id, before: { tags, section? }, after: { tags, section? } }` → removed;
 *   - more than MANUAL_LOG_MAX_EDITS edits or MANUAL_LOG_MAX_SNAPSHOTS
 *     snapshots → the oldest edits leave first (the same caps pushManualEdit keeps).
 * An intact edit keeps its identity, and so does an intact log.
 *
 * WHY: pushManualEdit counts `e.cards.length` of EVERY stored edit, and
 * undoManualEdit reads `e.id` of every edit. So one `null` in the stored log
 * made every triage, flag and undo command throw.
 *
 *   [null, {}, { id: 'edit-1', cards: [null, { id: 'c1', before: {…}, after: {…} }], … }]
 *     → [{ id: 'edit-1', cards: [{ id: 'c1', before: {…}, after: {…} }], … }]
 */
function mergeManualLog(log: DataState['manualLog'], repaired: string[]): DataState['manualLog'] {
  const out: ManualEdit[] = [];
  (log as unknown[]).forEach((e, i) => {
    if (!isObj(e)) {
      repaired.push(`manualLog #${i}: ${show(e)} is not an edit, removed`);
      return;
    }
    if (!isId(e.id)) {
      repaired.push(`manualLog #${i}: an edit with no usable id (${show(e.id)}), removed`);
      return;
    }
    const label = `manualLog ${JSON.stringify(e.id)}`;
    if (!Array.isArray(e.cards)) {
      repaired.push(`${label}: cards ${show(e.cards)} is not a list, the edit is removed`);
      return;
    }
    const r = repairer(e, label, repaired);
    const cards = e.cards.filter(isCardSnapshot);
    if (cards.length !== e.cards.length) {
      repaired.push(`${label}: ${e.cards.length - cards.length} of its ${e.cards.length} card entries could not be read, removed`);
      r.put('cards', cards);
    }
    if (e.notes !== undefined && !Array.isArray(e.notes)) {
      r.remove('notes');
    } else if (Array.isArray(e.notes)) {
      const notes = e.notes.filter(isNoteSnapshot);
      if (notes.length !== e.notes.length) {
        repaired.push(`${label}: ${e.notes.length - notes.length} of its ${e.notes.length} note entries could not be read, removed`);
        r.put('notes', notes);
      }
    }
    out.push(r.result() as unknown as ManualEdit);
  });

  // The caps: the oldest edits leave first.
  let start = 0;
  let total = out.reduce((sum, e) => sum + snapshotCount(e), 0);
  while (out.length - start > MANUAL_LOG_MAX_EDITS || total > MANUAL_LOG_MAX_SNAPSHOTS) {
    total -= snapshotCount(out[start]);
    start += 1;
  }
  if (start > 0) {
    repaired.push(
      `manualLog: the ${start} oldest edits removed (the log keeps at most ${MANUAL_LOG_MAX_EDITS} edits and ${MANUAL_LOG_MAX_SNAPSHOTS.toLocaleString('en-US')} snapshots)`,
    );
  }
  const kept = start > 0 ? out.slice(start) : out;
  return sameList(log, kept) ? log : kept;
}

/** Every ReviewBucket (a record, so TypeScript checks that the list is complete). */
const REVIEW_BUCKETS: Readonly<Record<ReviewBucket, true>> = { new: true, review: true, check: true };
const isReviewBucket = (v: unknown): v is ReviewBucket =>
  isString(v) && Object.prototype.hasOwnProperty.call(REVIEW_BUCKETS, v);

/** A value that may stand in `prev.knownAt` / `prev.knownCheckedAt`: null or a finite number (missing is fine too). */
const isTimeOrNull = (v: unknown): v is number | null => v === null || isFiniteNum(v);

/** A card's `newState` that undo may put back. */
const isNewState = (v: unknown): v is 'queued' | 'notStarted' => v === 'queued' || v === 'notStarted';

/**
 * A review-log `prev` that undo can put back on the card. Undo (reducer.ts
 * restorePrev) writes `prev` over the card AS IT IS, and removes `knownAt` /
 * `knownCheckedAt` when `prev` does not have them. So a broken `prev` would
 * break the card: `prev: { ease: null }` writes ease = null into the SM-2
 * math, and a Check's `prev: {}` takes a Known card out of Known. The rules
 * (what scheduleOf writes), and what a broken value becomes:
 *   - `ease`, `intervalDays`, `reps`, `lapses`, `due`: finite numbers;
 *   - `stepIndex`: null or a whole number ≥ 0; `lastReviewedAt`: null or finite;
 *   - `knownAt`, `knownCheckedAt`: missing, null or finite;
 *   - `newState`: missing, 'queued' or 'notStarted';
 *   - a Check (`bucket: 'check'`) is the rating of a Known card, so its
 *     `prev.knownAt` must be a finite number.
 * A broken value gets the value the card has NOW, when that one is valid:
 * then undo leaves that key as it is (it cannot know the old value, so it
 * changes nothing there). A key the card does not have is removed from
 * `prev`. When the card is gone, or its own value is broken too, the value
 * is a safe default, the same as a card's repair (repairSchedule): the
 * starting ease, 0, the time of the rating for `due`, null. A Check whose
 * card is no longer Known gets the time of the rating as `knownAt` (the card
 * WAS Known before the rating).
 *
 * WHY repair and not remove (spec §3.1 rule 4, "Repair, never drop"): the
 * rating itself is real. On the first copy from the old storage and on a
 * Restore, the row store writes the history rows (revlog) from the review
 * log, so a removed entry would lose its history row forever.
 *
 * Each repair is one line ("reviewLog #2: prev.ease null → 2.35"), written
 * with `say`. Returns `prev` itself when nothing was wrong.
 */
function repairPrev(
  prev: Obj,
  entry: Obj,
  card: Obj | null,
  ctx: { now: number; startingEase: number },
  say: (line: string) => void,
): Obj {
  let copy: Obj | null = null;
  const set = (key: string, value: unknown) => {
    say(`prev.${key} ${show(prev[key])} → ${show(value)}`);
    copy = copy ?? { ...prev };
    copy[key] = value;
  };
  const remove = (key: string) => {
    say(`prev.${key} ${show(prev[key])} removed`);
    copy = copy ?? { ...prev };
    delete copy[key];
  };
  /** The card's own value of `key` when it passes `ok`, else undefined. */
  const cardValue = <T>(key: string, ok: (v: unknown) => v is T): T | undefined =>
    card !== null && ok(card[key]) ? (card[key] as T) : undefined;
  /** The time of the rating (a broken one → now). */
  const at = isFiniteNum(entry.atMs) ? entry.atMs : ctx.now;

  if (!isFiniteNum(prev.ease)) set('ease', cardValue('ease', isFiniteNum) ?? ctx.startingEase);
  if (!isFiniteNum(prev.intervalDays)) set('intervalDays', cardValue('intervalDays', isFiniteNum) ?? 0);
  if (!isFiniteNum(prev.reps)) set('reps', cardValue('reps', isCount) ?? 0);
  if (!isFiniteNum(prev.lapses)) set('lapses', cardValue('lapses', isCount) ?? 0);
  if (!isFiniteNum(prev.due)) set('due', cardValue('due', isFiniteNum) ?? at);
  if (prev.stepIndex !== null && !isCount(prev.stepIndex)) {
    const isStep = (v: unknown): v is number | null => v === null || isCount(v);
    const reps = (copy ?? prev).reps as number;
    const current = cardValue('stepIndex', isStep); // null is a real value here ("graduated")
    // No usable value on the card: 0 (in learning) when it was studied, else null (like repairSchedule).
    set('stepIndex', current !== undefined ? current : reps > 0 ? 0 : null);
  }
  if (prev.lastReviewedAt !== null && !isFiniteNum(prev.lastReviewedAt)) {
    const current = cardValue('lastReviewedAt', isTimeOrNull);
    set('lastReviewedAt', current !== undefined ? current : null);
  }
  if (entry.bucket === 'check') {
    // A Check was the rating of a KNOWN card: before it, the card had a knownAt time.
    if (!isFiniteNum(prev.knownAt)) set('knownAt', cardValue('knownAt', isFiniteNum) ?? at);
  } else if (prev.knownAt !== undefined && !isTimeOrNull(prev.knownAt)) {
    const current = cardValue('knownAt', isTimeOrNull);
    if (current !== undefined) set('knownAt', current);
    else remove('knownAt');
  }
  if (prev.knownCheckedAt !== undefined && !isTimeOrNull(prev.knownCheckedAt)) {
    const current = cardValue('knownCheckedAt', isTimeOrNull);
    if (current !== undefined) set('knownCheckedAt', current);
    else remove('knownCheckedAt');
  }
  if (prev.newState !== undefined && !isNewState(prev.newState)) {
    const current = cardValue('newState', isNewState);
    if (current !== undefined) set('newState', current);
    else remove('newState');
  }
  return copy ?? prev;
}

/**
 * The review log (spec §3.4 `ReviewLogEntry`: the undo window of the last
 * ratings), in the shape `undoLastReview` and the row store read. Each
 * repair is listed:
 *   - an entry that is not an object, or has no card id (undo finds the
 *     card by it, and a history row needs it) → removed. On a rows load its
 *     history row stays: the row store never deletes a row the load left
 *     out (rowDiff.ts `setAside`). Its seq is NOT free again: when it was
 *     the newest entry, the log's highest seq is now lower than the
 *     table's, so the engine also asks the row store for the table's
 *     highest seq (rowStore.ts `highestRevlogSeq`, engine.ts nextMinSeq) —
 *     else the next rating would get that seq and write over (or be dropped
 *     next to) its history row;
 *   - a `prev` with a value undo cannot put back on the card (for example
 *     `prev: { ease: null }`, how a NaN ease is saved) → that value is
 *     REPAIRED, never the whole entry removed (repairPrev). A `prev` that is
 *     not an object is rebuilt the same way from `{}`. WHY: the first copy
 *     from the old storage and a Restore write the history rows from the
 *     review log, so a removed rating would lose its history row forever
 *     (spec §3.1 rule 4 "Repair, never drop", §3.8 the uncapped history);
 *   - `bucket` that is not 'new', 'review' or 'check' → the bucket the
 *     reducer gives (reducer.ts `reviewBucket`), read from `prev`: 'check'
 *     when the card was Known (`prev.knownAt` is a number: only a Known card
 *     is rated as a Check), else 'new' when it was never studied before this
 *     rating (`prev.reps === 0`), else 'review'. So undo takes the rating
 *     back from the right daily counter (a Check from `checks`);
 *   - `deckId` that is not a text → the deck of the card, or '' when the
 *     card is gone (undo then changes no deck's new-card count);
 *   - `seq` that is not a whole number, or that an EARLIER entry already
 *     has → a new seq after the highest one in the log. Not the entry's
 *     position: the seq is also the key of the history row, and a position
 *     can be the seq of another rating.
 * An intact entry keeps its identity, and so does an intact log.
 *
 * WHY: `untallyReview` reads `bucket`, so an entry without one made the
 * undo write `person.dayDone = undefined`, and the next rating threw.
 *
 *   [{ id: 'r1', cardId: 'c1', rating: 'good', atMs: …, prev: { reps: 0, … } }]   // no seq, bucket, deckId
 *     → [{ …, seq: 1, bucket: 'new', deckId: 'd1' }]
 */
function mergeReviewLog(
  log: DataState['reviewLog'],
  cards: readonly unknown[],
  ctx: { now: number; startingEase: number },
  repaired: string[],
): DataState['reviewLog'] {
  const entries = log as unknown[];
  // Each card by id (the first card with an id wins, like checkIntegrity). Built only when needed.
  let cardById: Map<string, Obj> | null = null;
  const cardOf = (cardId: string): Obj | null => {
    if (!cardById) {
      cardById = new Map();
      for (const c of cards) if (isObj(c) && isString(c.id) && !cardById.has(c.id)) cardById.set(c.id, c);
    }
    return cardById.get(cardId) ?? null;
  };
  // The deck of each card (the first card with an id and a deck wins, like checkIntegrity).
  let deckOfCard: Map<string, string> | null = null;
  const deckOf = (cardId: string): string => {
    if (!deckOfCard) {
      deckOfCard = new Map();
      for (const c of cards) if (isObj(c) && isString(c.id) && isString(c.deckId) && !deckOfCard.has(c.id)) deckOfCard.set(c.id, c.deckId);
    }
    return deckOfCard.get(cardId) ?? '';
  };
  let maxSeq = 0;
  for (const e of entries) if (isObj(e) && isCount(e.seq) && e.seq > maxSeq) maxSeq = e.seq;

  const seen = new Set<number>();
  const out: unknown[] = [];
  entries.forEach((e, i) => {
    if (!isObj(e)) {
      repaired.push(`reviewLog #${i}: ${show(e)} is not a rating, removed`);
      return;
    }
    if (!isId(e.cardId)) {
      repaired.push(`reviewLog #${i}: a rating with no usable card id (${show(e.cardId)}), removed`);
      return;
    }
    const label = `reviewLog #${i}`;
    const r = repairer(e, label, repaired);
    // The snapshot undo puts back (repairPrev). A prev that is not an object
    // is rebuilt from {}, with ONE line instead of one line per key.
    const card = cardOf(e.cardId);
    let prev: Obj;
    if (isObj(e.prev)) {
      prev = repairPrev(e.prev, e, card, ctx, (line) => repaired.push(`${label}: ${line}`));
    } else {
      repaired.push(`${label}: prev ${show(e.prev)} is not the card before the rating → rebuilt from the card as it is now`);
      prev = repairPrev({}, e, card, ctx, () => undefined);
    }
    if (prev !== e.prev) r.put('prev', prev);
    if (!isReviewBucket(e.bucket)) r.set('bucket', isFiniteNum(prev.knownAt) ? 'check' : prev.reps === 0 ? 'new' : 'review');
    if (!isString(e.deckId)) r.set('deckId', deckOf(e.cardId));
    if (!isCount(e.seq) || seen.has(e.seq)) {
      maxSeq += 1;
      r.set('seq', maxSeq);
    }
    seen.add(r.get('seq') as number);
    out.push(r.result());
  });
  return (sameList(log, out) ? log : out) as DataState['reviewLog'];
}

/** The starter pack record: null, or `{ id: <text>, installed: { key → deckId } }`. Anything else → null. */
function mergePack(raw: unknown, report: Report): DataState['pack'] {
  if (raw === undefined || raw === null) return null;
  const ok = isObj(raw) && isString(raw.id) && isObj(raw.installed) && Object.values(raw.installed).every(isString);
  if (ok) return raw as unknown as DataState['pack'];
  report('pack:', raw, null);
  return null;
}

/**
 * Fill every missing or wrong-typed field of a v3 document with its default,
 * so a missing field can never become `undefined` in the SRS math (an
 * `undefined` limit or ease gave NaN due dates). Unknown keys are kept.
 *
 *   - `settings` over DEFAULT_APP_SETTINGS, and `settings.srs` over DEFAULT_SRS;
 *   - `person` over the seed person, and `person.dayDone` over a zero day
 *     (with `checks` and `newByDeck`);
 *   - a missing list → `[]` (card types, notes, cards, decks, lists, sessions,
 *     review log, manual log, collections); `listPrefs` → {}; `pack` → null;
 *     a missing marker → `null`;
 *   - the saved lists and the list preferences: each damaged entry is
 *     repaired or removed (mergeLists, mergeListPrefs);
 *   - the review log: a rating with no card id is removed; a `prev` that
 *     undo cannot put back, and a missing bucket, deck or seq, are repaired
 *     (mergeReviewLog);
 *   - the manual-edit log: each edit that undo cannot read is removed, and
 *     so is each unreadable entry inside an edit (mergeManualLog);
 *   - a missing `onboarded` → true when the document has cards.
 * (A JSON `null` where a number belongs is how a NaN was saved, so it counts as missing.)
 *
 * `repaired` (optional): every STORED value that was replaced is added to it
 * as one readable line, e.g. "settings: sessionLimit null → 50" — the same
 * list `sanitize` writes, so the learner is told about every repair. A key
 * that was only missing is filled without a line (see `reporter`).
 */
export function mergeDefaults(s: DataState, now: number, repaired: string[] = []): DataState {
  const seed = buildSeedState(now);
  const raw = s as unknown as Obj;
  const report = reporter(repaired);
  const list = <K extends ListKey>(key: K): DataState[K] => listOf<DataState[K][number]>(raw, key, report) as DataState[K];
  const cards = list('cards');
  if (raw.onboarded !== undefined && typeof raw.onboarded !== 'boolean') {
    report('onboarded:', raw.onboarded, cards.length > 0);
  }
  return {
    ...s,
    noteTypes: list('noteTypes'),
    notes: list('notes'),
    cards,
    decks: list('decks'),
    lists: mergeLists(list('lists'), now, repaired),
    listPrefs: mergeListPrefs(raw.listPrefs, report, repaired),
    sessions: list('sessions'),
    reviewLog: mergeReviewLog(list('reviewLog'), cards, { now, startingEase: startingEaseOf(raw) }, repaired),
    manualLog: mergeManualLog(list('manualLog'), repaired),
    collections: list('collections'),
    settings: mergeSettings(raw.settings, { ...DEFAULT_APP_SETTINGS }, report, repaired) as unknown as AppSettings,
    person: mergePersonWith(
      raw.person,
      seed.person,
      (d) => mergeDayDone(d, seed.person.dayDone, report, repaired),
      report,
      repaired,
    ) as unknown as Person,
    onboarded: typeof raw.onboarded === 'boolean' ? raw.onboarded : cards.length > 0,
    inProgressSession: s.inProgressSession ?? null,
    pack: mergePack(raw.pack, report),
  };
}

/* ---------------------------------------------------------------- migrate */

const INVALID = { kind: 'invalid' } as const;

/** What `readHead` found: a reason to stop, or a readable document with its version and shape. */
type Head =
  | { kind: 'too-new'; version: number }
  | { kind: 'invalid' }
  | { kind: 'doc'; doc: Obj; from: number; shape: number };

/** The first checks of every migration: a document? too new? state-shaped? Then its version and shape. */
function readHead(doc: unknown): Head {
  // 1. Not a Maranki document: not an object, or a version that is not a whole number.
  if (!isObj(doc)) return INVALID;
  if (doc.schemaVersion !== undefined && !isCount(doc.schemaVersion)) return INVALID;
  const from = detectVersion(doc);

  // 2. Too new. Checked BEFORE the shape: a newer schema may have any shape,
  //    and it must be blocked (writes off), never replaced by the seed.
  const tooNew = tooNewFor(doc, CURRENT_SCHEMA);
  if (tooNew !== null) return { kind: 'too-new', version: tooNew };

  // 3. The shape every readable version shares.
  if (!isValidState(doc)) return INVALID;
  return { kind: 'doc', doc, from, shape: shapeOf(doc, from) };
}

/**
 * The schema-0/1/2 part of the chain: the step to schema 2, then the v2
 * repairs and defaults. The version fields of the result are
 * `schemaVersion = max(from, 2)` and `minReaderVersion = 2`.
 */
function stepsToV2(doc: Obj, from: number, now: number): { state: DataStateV2; repaired: string[] } {
  const legacy = doc as unknown as LegacyDoc;
  const stepped =
    from === 0 ? v0toV2(legacy, now) : from === 1 ? v1toV2(legacy, now) : ({ ...legacy } as unknown as DataStateV2);
  const { state: repairedState, repaired } = sanitizeV2(stepped, now);
  const merged = mergeDefaultsV2(repairedState, now, repaired);
  return {
    state: { ...merged, schemaVersion: Math.max(from, LAST_TEXT_SCHEMA), minReaderVersion: LAST_TEXT_SCHEMA },
    repaired,
  };
}

/**
 * Bring an OLD document (schema 0, 1 or 2) to schema 2, repaired, with every
 * v2 default — the first half of `migrate()`, without the step to the note
 * model. The migration tests read the v2 stage through it, and v2toV3 takes
 * its result. A document that already has the note model (schema 3) has no
 * schema-2 form: it is 'invalid' HERE (migrate() reads it).
 */
export function migrateToV2(doc: unknown, now: number): MigrateOutcomeV2 {
  const head = readHead(doc);
  if (head.kind !== 'doc') return head;
  if (head.shape > LAST_TEXT_SCHEMA) return INVALID;
  const { state, repaired } = stepsToV2(head.doc, head.from, now);
  return { kind: 'ok', state, from: head.from, repaired };
}

/**
 * Bring a stored document to today's schema. See the file comment for the
 * outcomes and the order of the steps.
 *
 * The version fields of the result: `schemaVersion = max(from, CURRENT_SCHEMA)`
 * (a newer document we may read is never downgraded) and
 * `minReaderVersion = MIN_READER`.
 *
 * May THROW on a bug: the caller must treat a throw as a read error and block
 * writes, never as corrupt data (the PersistController does).
 */
export function migrate(doc: unknown, now: number): MigrateOutcome {
  const head = readHead(doc);
  if (head.kind !== 'doc') return head;
  const { from, shape } = head;

  // 4. Old card texts → the note model; a v3 document is already there.
  const repaired: string[] = [];
  let v3: DataState;
  if (shape <= LAST_TEXT_SCHEMA) {
    const v2 = stepsToV2(head.doc, from, now);
    repaired.push(...v2.repaired);
    v3 = v2toV3(v2.state, now);
  } else {
    v3 = head.doc as unknown as DataState;
  }

  // 5. The links, then the values, then the defaults.
  const checked = checkIntegrity(v3, now);
  repaired.push(...checked.repaired);
  const clean = sanitize(checked.state, now);
  repaired.push(...clean.repaired);
  const merged = mergeDefaults(clean.state, now, repaired);
  return {
    kind: 'ok',
    state: {
      ...merged,
      // The type says 3; a newer document that we may read keeps its own higher number (rule 6).
      schemaVersion: Math.max(from, CURRENT_SCHEMA) as DataState['schemaVersion'],
      minReaderVersion: MIN_READER,
    },
    from,
    repaired,
  };
}
