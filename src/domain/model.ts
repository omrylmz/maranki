/**
 * Schema v3 — the note model (spec §3.4), plus the shared shapes that later
 * waves code against. This file is a CONTRACT: types only, no runtime code.
 *
 * It is a PARALLEL contract for now. The running app still uses the v2 shapes
 * in ./types.ts. In wave 3, W3-1 makes types.ts re-export this file, so
 * `DataState` becomes `DataStateV3` everywhere. Until then, new pure modules
 * (scheduler, facets, import planner, migration v2 → v3 …) import from here.
 *
 * Why the file stands alone: it imports only the shapes that never change
 * (`Rating`, `SrsSettings`, `Collection`, and `DataState` as a default type
 * argument). Every v3 shape is written out in full here, even when it is
 * almost the same as its v2 twin (`Person`, `SessionRecord`,
 * `InProgressSession`). So W3-1 can re-export this file from types.ts without
 * a circular "type X extends X" problem.
 *
 * Sections:
 *   §3.4  card types, notes, cards, decks, query and lists, logs, settings, state
 *   §3.3  LegacyCardV0 (the raw v0 card copy that Card.legacy keeps)
 *   §3.8  RevlogRow (one row of the uncapped review history)
 *   §5.1  the import pipeline (AnkiCollection → ImportChoices → ImportPlan → ImportResult)
 *   §6.2  card faces (Inline, FieldBlock, CardFace)
 *   §4.5  the scheduler's input and output (ScheduleCtx, Selection, ReadyCounts)
 *   §4.3  FacetFieldSpec (which fields are filter groups)
 *   §8.4  BackupEnvelope (the backup file)
 */
import type { Collection, DataState, Rating, SrsSettings } from './types';

/* Unchanged v2 shapes, re-exported so v3 code needs only this one import. */
export type { Collection, Rating, SrsSettings };

export type Id = string;

/* ------------------------------ card types (Anki "note types") ------------------------------ */

/** How a field is styled and used. It does NOT decide the side — the template does. */
export type FieldRole =
  | 'term' // big serif headline ("die Stunde")
  | 'meaning' // the answer headline ("the hour")
  | 'example' // italic serif sentence; several fields may have this role
  | 'exampleMeaning' // small muted line under an example
  | 'pronunciation' // mono font, e.g. /ˈʃtʊndə/
  | 'detail' // labelled row on the answer: "Perfekt · ist gewesen"
  | 'badge' // short value shown as a Pill (Level B1); usually a filter
  | 'hidden'; // stored and searchable, never shown

export interface FieldDef {
  /** Source name (Anki field or CSV header). Unique inside its NoteType. */
  name: string;
  /** Display label. Default = name. */
  label?: string;
  role: FieldRole;
  /** BCP-47 language for read-aloud, e.g. 'de-DE'. From {{tts de_DE:Word}}, the mapping step or a pack. */
  lang?: string;
  /** Filter-group override: 'auto' = the data rule of §4.3 decides; 'on' = always; 'off' = never. */
  facet: 'auto' | 'on' | 'off';
  /** Set when one value holds several ("regular, separable"). */
  multiSep?: ',' | ';' | '|';
}

export interface TemplateDef {
  /** 0 = first direction. */
  ord: number;
  /** "DE-EN". Shown as "German → English" when both sides have a lang. */
  name: string;
  /** Field indexes on the question side, in order. */
  prompt: number[];
  /** Field indexes added on the answer side, in order. */
  answer: number[];
  /** From {{type:Field}} → the typing target. */
  typeField?: number;
  /** Raw Anki question template, kept for re-derivation and export. */
  qfmt?: string;
  /** Raw Anki answer template. */
  afmt?: string;
}

export interface NoteType {
  id: Id;
  name: string;
  kind: 'standard' | 'cloze';
  /** Ordered. Note.fields is aligned with this array. */
  fields: FieldDef[];
  /** Ordered by ord. */
  templates: TemplateDef[];
  /** Anki `sortf`: the field used for A–Z sort, the duplicate check and the quiz. */
  sortField: number;
  /** Set on the built-in card types of src/domain/builtinTypes.ts. */
  builtin?:
    | 'basic'
    | 'basicReverse'
    | 'cloze'
    | 'legacyVocabDe'
    | 'legacyVocabEs'
    | 'legacyVocabFr'
    | 'legacyVocab';
  /** Where the type came from, so a re-import or a second CSV with the same columns reuses it. */
  source?: { ankiMid?: string; csvSignature?: string; packId?: string };
  createdAt: number;
  updatedAt: number;
}

/* ------------------------------------------ notes ------------------------------------------ */

export type SourceKind = 'manual' | 'csv' | 'apkg' | 'ankiweb' | 'pack' | 'migrated' | 'backup';

export interface Note {
  id: Id;
  typeId: Id;
  /** Aligned with NoteType.fields. RAW text: may contain Anki HTML (rendered safely, §6.2). */
  fields: string[];
  /** Anki tags as-is. '::' marks hierarchy. */
  tags: string[];
  /** Subdeck path below the deck root: '' or 'Verbs::B1'. */
  section: string;
  /**
   * Anki guid, or 'm-<random>' for manual/CSV/migrated notes. An import that
   * finds the same guid twice in one file gives the repeat 'm-<guid>~<k>'
   * (W2-5, so the same file imported again finds that note again).
   */
  guid: string;
  /** Source order (Anki new position or note id order, CSV row, createdAt). */
  order: number;
  source: { kind: SourceKind; ref?: string; ankiNoteId?: string };
  createdAt: number;
  updatedAt: number;
}

/* ------------------------------------------ cards ------------------------------------------ */

/**
 * Raw copy of a v0 card (v2.0.x APK / German fork), spec §3.3. Never edited.
 * Migration v2 → v3 lifts it into note fields (Level, Type, IPA …).
 */
export interface LegacyCardV0 {
  word: string;
  article: string | null;
  base: string;
  tr: string;
  ipa?: string;
  ex?: string;
  exTr?: string;
  level: string | null;
  type: string | null;
  lang: string;
}

export interface Card {
  id: Id;
  noteId: Id;
  /**
   * AUTHORITATIVE home deck. Invariant: all cards of one note have the same deckId.
   * Only the reducer writes it (moves are per note); checkIntegrity repairs it on load.
   */
  deckId: Id;
  /** Template ord (cloze: cloze number − 1). */
  ord: number;
  /** Read only while reps === 0. Absent = 'queued' (= New). */
  newState?: 'queued' | 'notStarted';
  /** Feed position inside the deck. Siblings share it. */
  newPos: number;
  /** Set by "I know it". Cleared by a missed check or by "Reset progress". */
  knownAt?: number | null;
  /** Set when a Check was passed. A Known card is checked at most once. */
  knownCheckedAt?: number | null;
  fav?: boolean;
  flagged?: boolean;
  /** Anki flag colour 1–7, stored for fidelity. The UI shows one flag. */
  flagColor?: number;
  suspended?: boolean;
  /** Epoch ms until which the card is buried (skipped), or null. */
  buriedUntil?: number | null;

  /* SRS — exactly today's fields, so srs.ts (applyRating, predictAll, stepLabel) is unchanged. */
  /** SM-2 ease factor. Starts at settings.srs.startingEase. */
  ease: number;
  /** Current graduated interval in days. 0 while still in learning. */
  intervalDays: number;
  /** Index into the learning steps. null once graduated. */
  stepIndex: number | null;
  reps: number;
  lapses: number;
  /** Next review due, epoch ms. */
  due: number;
  createdAt: number;
  lastReviewedAt: number | null;

  /** Deprecated (v2 → v4): raw v0 copy, kept until the contract release. */
  legacy?: LegacyCardV0;
}

/* ------------------------------------------ decks ------------------------------------------ */

export interface DeckOptions {
  /** Per-deck new-card cap. null = only the global daily limit. */
  newPerDay: number | null;
  /** 'random' = stable hash of the card id (pure). */
  newOrder: 'source' | 'random';
  /** What NEW cards added or imported into this deck get. */
  newArrival: 'queued' | 'notStarted';
  /** typeId → enabled ords. Absent = every ord that has cards. */
  directions?: Record<Id, number[]>;
  /** Default true: sample 10% of Known cards for one Check. */
  knownChecks: boolean;
}

export interface Deck {
  id: Id;
  name: string;
  /** Emoji. */
  icon: string;
  desc?: string;
  /** false = paused. */
  active: boolean;
  /** Position in deck lists and in the new-card round robin. */
  order: number;
  source: SourceKind;
  /** 'pack:german:vocabulary' | 'ankiweb:<id>' | 'file:<name>' → idempotent add / re-import. */
  sourceKey?: string;
  /** BCP-47 fallback for term/example fields of NON-Anki card types (made in the app or from CSV: no source.ankiMid). */
  language?: string;
  /** BCP-47 fallback for meaning fields of non-Anki card types. */
  meaningLanguage?: string;
  /** German article colours (§9.2). Default true when the term language is German. */
  genderColors?: boolean;
  /** Card type for cards made in the app: 'nt-basic' (default) or 'nt-basic-reverse'. */
  defaultTypeId?: Id;
  /**
   * True when the learner CHOSE `defaultTypeId` in the deck editor. Only then
   * is a Basic there a choice: every deck gets Basic when it is made
   * (makeDeck), so without this flag Basic means "nobody chose" (roles.ts
   * newCardTypeId). Absent = not chosen.
   */
  defaultTypeChosen?: boolean;
  options: DeckOptions;
  createdAt: number;
  /** Deprecated (v2 → v4). */
  builtin?: boolean;
  /** Deprecated (v2 → v4): raw v0 deck values. */
  legacy?: { flag?: string; lang?: string; level?: string | null };
}

/* -------------------------------------- query and lists -------------------------------------- */

export type LifeKey = 'notStarted' | 'new' | 'learning' | 'review' | 'mastered' | 'known';
export type FlagKey = 'fav' | 'flagged' | 'suspended' | 'buried' | 'paused';

/** Flat and chip-normal: AND of groups, OR inside a group. Every group is one removable chip. */
export interface Query {
  /** A ListDef id or 'builtin:<name>'. Resolved first, then AND the rest. */
  list?: string;
  /** OR. */
  decks?: Id[];
  /** OR. Prefix match on '::' boundaries. */
  sections?: { deckId: Id; path: string }[];
  /** Folded field name → folded values. OR inside, AND across. */
  fields?: Record<string, string[]>;
  /** OR. */
  noteTypes?: Id[];
  /** Ords, OR. */
  directions?: number[];
  /** OR. Folded. 'algo' matches 'Algo::Core_Patterns::X'. */
  tags?: string[];
  /** None may match. */
  notTags?: string[];
  /** OR. */
  life?: LifeKey[];
  /** Urgency. */
  due?: 'now' | 'today';
  /** AND. */
  flags?: FlagKey[];
  /** None may hold. */
  notFlags?: FlagKey[];
  /** reps > 0 && ease <= 2.2 && not Known. */
  hard?: boolean;
  /** reps > 0 && intervalDays <= 7 && not Known. */
  young?: boolean;
  /** lapses >= 8. */
  leech?: boolean;
  /** Folded. Every word must match. "quoted phrase" = one word. */
  text?: string;
}

export interface SortSpec {
  by: 'source' | 'due' | 'az' | 'newest' | 'hardest' | 'field';
  /** Folded field name, for by: 'field' (ordinal sort, §4.3). */
  field?: string;
  dir?: 'asc' | 'desc';
}

/** A saved filter ("B1 verbs"). Always up to date; not a folder. */
export interface ListDef {
  id: Id;
  name: string;
  icon: string;
  query: Query;
  sort?: SortSpec;
  createdAt: number;
  updatedAt: number;
}

/** Per-list display preferences, for user lists AND the built-in lists of code. */
export interface ListPref {
  pinned: boolean;
  hidden: boolean;
  order: number;
}

/* ---------------------------------------- logs and days ---------------------------------------- */

/** Which daily budget a rating used: 'new' (first study), 'review', or 'check' (a Known card). */
export type ReviewBucket = 'new' | 'review' | 'check';

/** One rating in the UNDO window (in memory, capped at 400). */
export interface ReviewLogEntry {
  id: string;
  /** Monotonic. Also the revlog row key. */
  seq: number;
  cardId: Id;
  /** So undo can untally newByDeck. */
  deckId: Id;
  rating: Rating;
  atMs: number;
  /** Replaces wasNew ('new' ⇔ wasNew). */
  bucket: ReviewBucket;
  /** The card's values before this rating — restored by undo. */
  prev: Pick<
    Card,
    | 'ease'
    | 'intervalDays'
    | 'stepIndex'
    | 'reps'
    | 'lapses'
    | 'due'
    | 'lastReviewedAt'
    | 'knownAt'
    | 'knownCheckedAt'
    | 'newState'
  >;
  /** Reveal → rate, in ms. */
  durationMs?: number;
}

export type ManualKind =
  | 'flags'
  | 'move'
  | 'tags'
  | 'reschedule'
  | 'reset'
  | 'known'
  | 'learn'
  | 'notStarted'
  /** "Bury until tomorrow" in a session: `buriedUntil` (its snackbar Undo takes it back). */
  | 'bury';

/** The card keys a manual edit may change (and undo may restore). */
export type CardPatch = Partial<
  Pick<
    Card,
    | 'fav'
    | 'flagged'
    | 'suspended'
    | 'deckId'
    | 'newState'
    | 'newPos'
    | 'knownAt'
    | 'knownCheckedAt'
    | 'ease'
    | 'intervalDays'
    | 'stepIndex'
    | 'reps'
    | 'lapses'
    | 'due'
    | 'lastReviewedAt'
    | 'buriedUntil'
  >
>;

/** Undo for edits made OUTSIDE a review. Never stored in reviewLog (session undo pops reviewLog). */
export interface ManualEdit {
  id: string;
  at: number;
  kind: ManualKind;
  /** Snackbar text, e.g. "12 cards suspended". */
  label: string;
  cards: { id: Id; before: CardPatch; after: CardPatch }[];
  notes?: {
    id: Id;
    before: { tags: string[]; section?: string };
    after: { tags: string[]; section?: string };
  }[];
}

/** What was studied on one calendar day. v3 adds `checks` and `newByDeck`. */
export interface DayDone {
  dayKey: string;
  reviews: number;
  neww: number;
  checks: number;
  /** deckId → new cards studied today in that deck (the per-deck new cap). */
  newByDeck: Record<Id, number>;
}

/**
 * 'scheduled' | 'ahead' | 'practice' are written by new code.
 * 'cram' | 'hardest' | 'deck' | 'collection' are legacy values, still readable
 * in SessionRecord and in-flight markers.
 */
export type SessionKind =
  | 'scheduled'
  | 'ahead'
  | 'practice'
  | 'cram'
  | 'hardest'
  | 'deck'
  | 'collection';

export type StudyMode = 'flash' | 'type' | 'mc' | 'mix' | 'article';

/** A finished session. Same fields as the v2 shape, plus `mode` and `scopeLabel`. */
export interface SessionRecord {
  id: string;
  dayKey: string;
  atMs: number;
  kind: SessionKind;
  counts: Record<Rating, number>;
  total: number;
  bestRun: number;
  xp: number;
  /** The study mode used (absent on sessions saved before v3). */
  mode?: StudyMode;
  /** What was studied, e.g. "German · Level A2" (absent on sessions saved before v3). */
  scopeLabel?: string;
}

/**
 * A study session in flight (the M5 marker). Shape unchanged from v2, except
 * that `kind` is the v3 SessionKind and the optional `mode`. The boot
 * reconciler banks its payout once.
 */
export interface InProgressSession {
  kind: SessionKind;
  label: string;
  counts: Record<Rating, number>;
  total: number;
  bestRun: number;
  durationSec: number;
  fastAnswers: number;
  /** The day the session's reviews belong to (its start day). Optional: older markers lack it. */
  studyDay?: string;
  /**
   * The study mode of the session at its last rating (wave 5h). The boot
   * reconcile writes it to `SessionRecord.mode`, like a normal completion
   * does. Optional: markers saved before wave 5h lack it, and their record
   * then has no mode (as before).
   */
  mode?: StudyMode;
}

/** The learner's progress. Same fields as the v2 shape; `dayDone` is the v3 DayDone. */
export interface Person {
  xp: number;
  streak: number;
  bestStreak: number;
  freezes: number;
  /** Day keys on which a freeze bridged a missed day (for the 14-day strip). */
  freezeUsedDays: string[];
  lastStudyDay: string | null;
  goalReviews: number;
  goalNew: number;
  dayDone: DayDone;
  /** Lifetime count of fast answers (reveal → rate under 3 s), for Quick draw. */
  fastAnswers: number;
  /** Achievement id → unlocked-at epoch ms. */
  achievements: Record<string, number>;
}

/* ----------------------------------------- settings ----------------------------------------- */

export interface AppSettings {
  /** Unchanged type. dailyReviewLimit min 10 (UI): 0 ("no reviews") is no longer allowed. */
  srs: SrsSettings;
  /** Show the speaker button. */
  readAloudEnabled: boolean;
  /** Speak the question when a card appears. */
  autoReadAloud: boolean;
  hapticsEnabled: boolean;
  /** Default false. */
  reminderEnabled: boolean;
  /** 'HH:MM', default '20:00'. */
  reminderTime: string;
  /** Default true. */
  reminderSkipStudied: boolean;
  /** 0 = "No limit". Applies to EVERY session kind. Default 50. */
  sessionLimit: number;
  studyMode: 'flash' | 'type' | 'mc' | 'mix';
  hintsEnabled: boolean;
  /** Offer "Practice the n you missed" first on Complete. */
  retryMissed: boolean;
  /** Default true: both directions of one item not on the same day. */
  spaceSiblings: boolean;
  /** Default 5. 0 = no checks. */
  knownChecksPerDay: number;
  /** Default true: weekly backup kept on the phone (3 newest). */
  autoBackup: boolean;
  lastAutoBackupAt: number | null;
  /** Default true: include imported images in exported backups (≤ 50 MB). */
  backupImages: boolean;
  /** Default false: the one-time Today reminder offer was shown or dismissed. */
  reminderOfferSeen: boolean;
}

/* ------------------------------------------- state ------------------------------------------- */

export interface DataStateV3 {
  schemaVersion: 3;
  minReaderVersion: 3;
  noteTypes: NoteType[];
  notes: Note[];
  cards: Card[];
  decks: Deck[];
  /** User lists only. Built-in lists are code (§4.7). */
  lists: ListDef[];
  listPrefs: Record<string, ListPref>;
  person: Person;
  sessions: SessionRecord[];
  /** Undo window, ≤ 400. */
  reviewLog: ReviewLogEntry[];
  /** ≤ 50 edits and ≤ 20,000 card snapshots in total. */
  manualLog: ManualEdit[];
  settings: AppSettings;
  onboarded: boolean;
  /** Shape unchanged except kind: SessionKind (and the optional `mode`, wave 5h). */
  inProgressSession: InProgressSession | null;
  /** Starter key → deckId. */
  pack: { id: string; installed: Record<string, Id> } | null;
  /** Deprecated (v2 → v4). Non-optional (default []) so the old screens compile until wave 4 replaces them. */
  collections: Collection[];
}

/* ------------------------------------------ revlog (§3.8) ------------------------------------------ */

/**
 * One row of the append-only review history (`revlog` table of the row store).
 * It is NOT kept in memory; `history.ts` reads it for the history CSV and the
 * CardSheet "History" line. A backup file may carry these rows (§8.4).
 *
 * Column mapping (SQL → field): seq → seq, card_id → cardId, deck_id → deckId,
 * at_ms → atMs, rating → rating, bucket → bucket, ivl_before → ivlBefore,
 * ivl_after → ivlAfter, ease_after → easeAfter, duration_ms → durationMs.
 */
export interface RevlogRow {
  /** Same as ReviewLogEntry.seq. Primary key. */
  seq: number;
  cardId: Id;
  deckId: Id;
  /** When the card was rated, epoch ms. */
  atMs: number;
  rating: Rating;
  bucket: ReviewBucket;
  /** Card.intervalDays before the rating (days). */
  ivlBefore: number;
  /** Card.intervalDays after the rating (days). */
  ivlAfter: number;
  /** Card.ease after the rating. */
  easeAfter: number;
  /** Reveal → rate in ms. null when unknown (older entries). */
  durationMs: number | null;
}

/* ------------------------------------- import pipeline (§5.1) ------------------------------------- */

/**
 * Everything read from an .apkg (or a CSV, in the same shape), LOSSLESS and raw.
 * Ids are strings because Anki ids are 64-bit numbers that do not fit a JS number.
 *
 * The keys of `models`, `decks` and `media` come from the file, so they are
 * untrusted: a key can be "__proto__" or "constructor". The readers build these
 * records with `Object.create(null)` (no prototype), and code that looks a key
 * up must check that it is the record's OWN key (H2, `ownValue` in plan.ts):
 * `models['constructor']` on a plain object is Object's constructor function,
 * not a model.
 */
export interface AnkiCollection {
  fileName: string;
  /** col.crt in seconds (needed to convert review due days to dates). */
  crt: number;
  /** Anki models (card types) by model id. type 0 = standard, 1 = cloze. */
  models: Record<
    string,
    {
      name: string;
      type: 0 | 1;
      sortf: number;
      flds: { name: string; ord: number }[];
      tmpls: { name: string; ord: number; qfmt: string; afmt: string }[];
    }
  >;
  /** did → full name, e.g. "German::Verbs::B1". */
  decks: Record<string, string>;
  notes: { id: string; guid: string; mid: string; flds: string[]; tags: string[] }[];
  cards: {
    id: string;
    nid: string;
    did: string;
    /** Original deck id when the card sits in a filtered deck; '0' otherwise. */
    odid: string;
    ord: number;
    type: number;
    queue: number;
    /**
     * The card's due IN ITS HOME DECK. A card in a filtered deck (odid != '0')
     * keeps its real due in Anki's `odue` column, and `due` only holds its
     * place in the filtered deck (-100000 + n). So when odid != '0' and
     * odue != 0, the .apkg reader puts `odue` here, like Anki's own importer.
     * (odue = 0 means the card was answered in the filtered deck: then `due`
     * is already the real one.)
     */
    due: number;
    /**
     * Added by W2-5 (not in spec §5.1): Anki's raw `odue` column, kept for
     * reference only. The reader has already used it for `due` (see above).
     * Absent or 0 = nothing to restore (the card is not in a filtered deck,
     * or it was answered there).
     */
    odue?: number;
    ivl: number;
    factor: number;
    reps: number;
    lapses: number;
    flags: number;
    /**
     * Added by H2 (not in spec §5.1): the card's ORIGINAL new-card position,
     * from Anki's `cards.data` JSON (`{"pos": 12}`). Anki 2.1.55+ writes it
     * when a new card is studied for the first time, because `due` then stops
     * being the position. The planner uses it so that notes studied in Anki
     * keep their place in the deck order (Note.order). Absent = unknown (older
     * Anki, genanki, CSV, or a new card: its position is `due`).
     */
    originalPos?: number;
  }[];
  /** Media manifest only: "0" → "example.webp". */
  media: Record<string, string>;
  /** Lazy reader over the unzipped archive, by file name. Images only. */
  mediaBytes?: (name: string) => Uint8Array | null;
  /**
   * Added by W2-5 (not in spec §5.1): the UNCOMPRESSED size in bytes of one
   * media file, by file name, read from the zip directory without unpacking
   * the file. null = the archive does not contain it. The media plan needs the
   * total size ("Import 180 MB of images?") without reading every image.
   */
  mediaSize?: (name: string) => number | null;
  /**
   * Present when the source was a CSV or an Anki text export. Column numbers
   * are 0-based and index into the file's rows (and into `header` when there
   * is one).
   */
  csv?: {
    /** The header cells as written (all columns), or null when the file has no header row. */
    header: string[] | null;
    delimiter: string;
    html: boolean;
    guidCol?: number;
    deckCol?: number;
    notetypeCol?: number;
    /**
     * The tags column, when the file has one. Read it together with
     * `tagsSpill` and `tagsSyntax` (both are set whenever `tagsCol` is set):
     * the column number alone does not say how many columns hold tags.
     */
    tagsCol?: number;
    /**
     * Added by W2-5. true = today's positional rule for a plain CSV WITHOUT a
     * header: `tagsCol` AND every column after it hold tags (0 Front · 1 Back ·
     * 2 Example · 3 Notes · 4+ Tags). false = only the one `tagsCol` column
     * (an Anki `#tags column:N`, a header cell named "Tags", or the Fields
     * screen's "Tags" choice).
     */
    tagsSpill?: boolean;
    /**
     * Added by W2-5. How the tags in a cell are separated: 'anki' = white
     * space (an Anki `#tags column:N`), 'list' = | ; or , (today's rule).
     */
    tagsSyntax?: 'anki' | 'list';
  };
}

/** What the learner chose on the import screen (§5.9). */
export interface ImportChoices {
  /** Chosen dids (all by default). */
  sections: Set<string>;
  target: { kind: 'new'; name: string; icon: string } | { kind: 'existing'; deckId: Id };
  /**
   * Per source model id: roles/labels/lang/facet of each field + the enabled
   * directions (ords). `fields` is aligned with the model's fields (by ord).
   *
   * `templates` (optional, added by W2-5): the directions as roles.ts
   * worked them out (`parseTemplate`, spec §5.3), with the final roles. When it
   * is given, the planner stores it as it is. When it is absent, the planner
   * reads the field references of `qfmt`/`afmt` itself with the same rules
   * (prompt = question fields that are not badges; answer = answer fields not
   * in the prompt and not badges).
   *
   * For a cloze card type `ords` is not used: every cloze card of a chosen
   * note is imported.
   *
   * When the library already has a card type for this source (W2-5,
   * plan.ts `findReusableType`): an Anki model that was imported before is
   * REUSED and keeps its own roles (these `fields`/`templates` are not used;
   * the Fields screen shows that type's roles). A CSV card type with the same
   * columns is reused only when these `fields` (and `templates`, if given)
   * equal its roles; otherwise the learner's choice wins and a new card type
   * is made. So the Fields screen should start from `findReusableType`'s
   * roles: unchanged, the file reuses the type.
   *
   * The planner reads only OWN keys of this record (H2), so a model id like
   * "constructor" never finds Object's built-in function here. A screen that
   * builds it for a file with a model id "__proto__" should use
   * `Object.create(null)` (a plain `{}` drops that key: the planner then uses
   * today's positions for that card type).
   */
  types: Record<string, { fields: FieldDef[]; ords: number[]; templates?: TemplateDef[] }>;
  /** Anki scheduling: keep it or start every card as New. */
  progress: 'keep' | 'reset';
  /** For NEW cards. */
  arrival: 'queued' | 'notStarted';
  /**
   * "Where do you start?": cards whose ordinal rank in `facet` (a facet key,
   * e.g. 'field:level' or 'section') is below `fromRank` become Known or stay
   * Not started. For 'section' the rank is read from the LAST level of the
   * note's section ("Vocabulary::A1" → A1).
   */
  placement?: { facet: string; fromRank: number; below: 'known' | 'notStarted' };
  /** Same guid already in ANOTHER deck. */
  elsewhere: 'update' | 'copy' | 'skip';
  /** Default true. */
  images: boolean;
  /**
   * NOT in spec §5.1 (added by W0-2 for the preview's "[Skip these {n}]"
   * button, §5.6 rule 5): true = skip the notes whose headword already
   * appears in another deck with a different guid. Absent = import them.
   */
  skipOverlap?: boolean;
  /**
   * Added for starter decks (2026-10): true = a note updated in the TARGET
   * deck also moves to the section the file gives it now (a newer version of
   * the deck moved the word to another subdeck, for example from B1 to A2):
   * the same section a fresh add of the whole file gives. Only a starter deck
   * sets it: its file is always imported whole, so its subdecks ARE the
   * deck's sections. Absent = an update keeps the section (the import screen:
   * the chosen sections decide the section paths there).
   */
  followSections?: boolean;
}

/**
 * A library card type that an import UPGRADES to a newer version of its Anki
 * model (plan.ts `upgradeNoteType`): the model got new fields, lost fields,
 * or got new directions. The type keeps its id, so its notes, cards and
 * progress stay.
 */
export interface NoteTypeUpgrade {
  /** The card type as it is after the import (the SAME id as the library type). */
  type: NoteType;
  /**
   * The field names the library type had when the import was planned. The
   * reducer upgrades the type only while it still has exactly these names
   * (else the plan is out of date for this type, and the type stays as it is).
   * A name of `fromFields` that `type` no longer has is a REMOVED field: the
   * reducer removes it only while no note of the type that the plan does not
   * update has text in it (noteOps `fieldHasText`).
   */
  fromFields: string[];
}

/** The exact result of planning an import. The reducer applies it in one step (`applyImport`). */
export interface ImportPlan {
  /**
   * New card types to add, source model id → existing type id to reuse, and
   * library card types to upgrade. An upgraded type is ALSO in `reuse` (its id
   * does not change).
   * `reuse` has no prototype (H2: a model id from the file can be "__proto__"),
   * so read it with Object.keys / Object.entries, not `reuse.hasOwnProperty`.
   */
  noteTypes: { add: NoteType[]; reuse: Record<string, Id>; upgrade: NoteTypeUpgrade[] };
  /**
   * `update`: new field values and tags, in the field order of the note's card
   * type AFTER the upgrades of this plan; `section` only when the note moves
   * to another section (ImportChoices.followSections).
   *
   * `retire` (starter decks only, starterDecks.ts): notes of the starter deck
   * that a newer version of its bundled file no longer has. Nothing is
   * deleted: the reducer suspends their cards and adds the tag RETIRED_TAG,
   * so they leave the study queue and can be found again. Empty for every
   * other import.
   */
  notes: { add: Note[]; update: { id: Id; fields: string[]; tags: string[]; section?: string }[]; retire: Id[] };
  /** New cards only. Updates keep their cards and progress. */
  cards: { add: Card[] };
  /** null when the target is an existing deck, or when nothing is new. */
  deck: Deck | null;
  /**
   * Image files to write AFTER the save commits, one entry per deck folder
   * (`media/<deckId>`) with the manifest file names to write there. Only
   * folders that get files are listed; empty = nothing to write.
   *
   * Changed by W2-5 from spec §5.1's single `{ deckFolder, files }`: a note
   * updated "where it is" (choices.elsewhere 'update') lives in ANOTHER deck,
   * so the images its new field text uses go to THAT deck's folder. The
   * target deck's folder comes first.
   */
  media: ImportMediaFolder[];
  /** Every preview line comes from here. */
  summary: ImportSummary;
}

/** The image files of one deck folder that an import writes after the save commits. */
export interface ImportMediaFolder {
  /** `media/<deckId>`, relative to the app's document folder. */
  deckFolder: string;
  /** The names the files get in the folder ("example.webp"), each once. */
  files: string[];
  /**
   * The files whose folder name is NOT their archive name: the folder already
   * had a different picture under that name (mediaPlan.ts `freeImageName`),
   * so the file got its own name and the notes' `<img src>` were rewritten.
   * `name` is in `files`; `from` is the manifest name to read the bytes by.
   * Absent = every file keeps its archive name.
   */
  renamed?: { name: string; from: string }[];
}

/**
 * Why notes of the chosen sections were NOT imported, one count per reason
 * (added by W2-5), so the Preview and Done screens can name each reason
 * instead of one lumped number. `notesSkipped` is the sum of the four.
 */
export interface ImportSkips {
  /**
   * §5.6 rule 4: the note has no guid (a CSV without a guid column) and the
   * target deck already has a note of the same card type with the same
   * (folded) sort field. Two CSV card types with the same columns (the same
   * CSV signature) count as the same card type here. Done "{s} items skipped (already here)".
   */
  alreadyHere: number;
  /** §5.6 rule 3: the same guid is in another deck and choices.elsewhere is 'skip' ("Skip them"). */
  elsewhere: number;
  /** §5.6 rule 5: the same headword is in another deck and choices.skipOverlap is on ("[Skip these {n}]"). */
  overlap: number;
  /**
   * The note would get no card: every enabled direction has an empty
   * question side or no card row in the file, or its card type is unknown.
   */
  empty: number;
}

/**
 * The numbers behind every Preview and Done line (§5.6, §5.9). The planner
 * builds them from the plan itself, so they always equal the plan's contents
 * (W2-5 pins that with a property test). "Notes" are called "items" in the UI.
 */
export interface ImportSummary {
  /** = plan.notes.add.length. "15,960 cards from {8,433} items". */
  notesAdded: number;
  /**
   * = plan.cards.add.length: the cards of new notes + cards for newly enabled
   * directions of updated notes. "{15,960} cards" / Done "{n} cards added".
   */
  cardsAdded: number;
  /** Distinct non-empty `note.section` values among the ADDED notes. "· {15} sections". */
  sections: number;
  /** Labels of the filter groups found in the imported data. "Filters found: Level, Section, Verb tags". */
  filtersFound: string[];
  /** Notes whose guid is already in the TARGET deck (updated or unchanged). "Already in this deck: {n}". */
  inTargetDeck: number;
  /** Notes whose guid is in ANOTHER deck (they follow choices.elsewhere). "Already in other decks: {n}". */
  inOtherDecks: number;
  /** = plan.notes.update.length: notes whose fields or tags change. Done "{u} items updated". */
  notesUpdated: number;
  /**
   * Added by W2-5: notes matched by guid (in the target deck, or elsewhere
   * with "Update them where they are") whose fields and tags already equal
   * the file. They are NOT in plan.notes.update.
   * Nothing added + nothing updated + unchanged > 0 → "Already up to date."
   */
  notesUnchanged: number;
  /** Cards that belong to the updated notes. Done "Updated {n} cards ({u} items) in {decks}." + "Nothing new." */
  cardsUpdated: number;
  /** Names of the decks that hold the updated notes, for "Updated {n} cards ({u} items) in {decks}." */
  updatedDecks: string[];
  /**
   * = plan.noteTypes.upgrade.length: library card types that get the new
   * fields or directions of a newer version of their Anki model.
   */
  cardTypesUpdated: number;
  /** = plan.notes.retire.length: starter-deck notes the newer file no longer has (their cards get suspended). */
  notesRetired: number;
  /** Notes not imported = the sum of `skipped`. */
  notesSkipped: number;
  /** Added by W2-5: `notesSkipped` split by reason. */
  skipped: ImportSkips;
  /**
   * Added notes whose guid was used by an earlier note of the same file, so
   * they got their own guid ('m-<guid>~<k>', the same on every import of the
   * file). "{n} duplicate ids in this file were renamed."
   */
  guidsRenamed: number;
  /**
   * Same headword in another deck with a different guid, largest first. "{n}
   * items have the same text as items in {deck}." (importFile.ts overlapText).
   * Counted BEFORE choices.skipOverlap is applied, so the line (and its
   * button) stays when the user skips them. One note can count for more than
   * one deck.
   */
  overlap: { deckId: Id; deckName: string; notes: number }[];
  /**
   * Added cards that carry Anki study progress, counted before
   * choices.progress is applied. "Study progress in this file: {830} cards".
   * With progress 'keep' it equals the added cards with reps > 0.
   */
  progressCards: number;
  /** Added cards suspended in Anki (queue = -1). "Suspended in Anki: {n}". */
  suspended: number;
  /** Added cards with reps === 0. Drives "How should new cards start?" (> 200) and its default (> 1,000). */
  newCards: number;
  /** Added cards that start Not started (arrival or placement). */
  notStarted: number;
  /** Added cards marked Known by placement. Done "{k} cards marked Known (easier levels)." */
  markedKnown: number;
  /**
   * Ordinal groups that "Where do you start?" can offer. `facet` is the facet
   * key ('field:level', 'section'); `values` are in rank order, so
   * ImportChoices.placement.fromRank is an index into them. Empty = the block is hidden.
   * The 'section' group lists the LAST levels of the sections ("Vocabulary::A1",
   * "Verbs::A2" → A1, A2), so nested sections can offer it too.
   */
  placementGroups: { facet: string; label: string; values: string[] }[];
  /**
   * = the number of files in plan.media, all folders together (a file used in
   * two decks is written, and counted, once per folder). "Images: {57} — will be imported".
   */
  images: number;
  /** Total bytes of those images. */
  imageBytes: number;
  /**
   * Added by W2-5: images that the imported notes reference AND the file
   * contains, whether or not they are imported (choices.images may be off).
   * The imported notes = the added notes and the notes matched by guid, in
   * every deck they are in; counted per deck folder like `images`.
   */
  imagesFound: number;
  /** Total bytes of `imagesFound`. */
  imagesFoundBytes: number;
  /** imagesFoundBytes > 50 MB: the preview asks first ("Import 180 MB of images?"). */
  imagesAskFirst: boolean;
  /**
   * Distinct [sound:x] clips in the imported notes (added, and matched by guid
   * in any deck). "{n} audio clips — not imported yet."
   */
  audioClips: number;
}

/**
 * What `applyImport` really applied. It equals the plan's summary unless the
 * library changed between planning and applying (for example a note to update
 * was deleted in the meantime): then this result is the truth. So the Done
 * lines (§5.6, §5.9) are built from this result, never from `plan.summary`.
 */
export interface ImportResult {
  /**
   * The deck the Done screen opens: the new deck or the existing target. null
   * when no deck was created or targeted (every note updated elsewhere or skipped).
   */
  deckId: Id | null;
  /** True when this import created `deckId`. */
  deckCreated: boolean;
  /** Notes really added. */
  notesAdded: number;
  /** Cards really added. Done "{n} cards added". */
  cardsAdded: number;
  /** Notes really updated. Done "{u} items updated". */
  notesUpdated: number;
  /** Added by W2-5: notes matched by guid that needed no change ("Already up to date."). */
  notesUnchanged: number;
  /** Cards that belong to the notes really updated. Done "Updated {n} cards ({u} items) in {decks}." + "Nothing new." */
  cardsUpdated: number;
  /** Names of the decks that hold the notes really updated, for "Updated {n} cards ({u} items) in {decks}." */
  updatedDecks: string[];
  /** Card types really upgraded (new fields or directions, see NoteTypeUpgrade). */
  cardTypesUpdated: number;
  /** Notes really retired (ImportPlan.notes.retire that still existed): their cards are suspended now. */
  notesRetired: number;
  /** Notes not imported = the sum of `skipped`. */
  notesSkipped: number;
  /** Added by W2-5: notesSkipped split by reason. Done "{s} items skipped (already here)" reads skipped.alreadyHere. */
  skipped: ImportSkips;
  /** Cards that got knownAt from placement. */
  markedKnown: number;
  /** The image files the caller writes after the save commits, per deck folder (echo of plan.media). */
  media: ImportMediaFolder[];
}

/* ---------------------------------------- card faces (§6.2) ---------------------------------------- */

/** One piece of a rendered line: styled text, an image, or a sound token. */
export type Inline =
  | { t: 'text'; text: string; b?: boolean; i?: boolean; u?: boolean; sub?: boolean; sup?: boolean }
  | { t: 'img'; src: string }
  | { t: 'sound'; src: string };

/** One field, ready to draw. */
export interface FieldBlock {
  /** Index into Note.fields / NoteType.fields. */
  field: number;
  label: string;
  role: FieldRole;
  /** The safe HTML subset as lines of inlines. */
  lines: Inline[][];
  /** The same text as one plain string (rows, snackbars, a11y, read-aloud). */
  plain: string;
  /** Resolved BCP-47 language for read-aloud, if known. */
  lang?: string;
}

/** A card's two sides, derived from its note (never stored). */
export interface CardFace {
  /** One line for rows, snackbars, a11y (replaces card.front). */
  promptPlain: string;
  /** One line (replaces card.back). */
  answerPlain: string;
  /** Pills on the top row (Level B1). */
  badges: FieldBlock[];
  /** Question side. First = headline. */
  prompt: FieldBlock[];
  /** Revealed side. First = headline. */
  answer: FieldBlock[];
}

/* ---------------------------------------- the scheduler (§4.5) ---------------------------------------- */

/**
 * Everything the scheduler needs besides the pool: `selectScheduled`,
 * `selectAhead`, `selectPractice`, and the Study eligibility check
 * `studyEligible(card, ctx, explicitDecks)` (§4.5). Pure data plus small
 * lookup functions, so schedule.ts depends on no other wave-2 module (not on
 * MatchCtx or LibraryIndex, which W2-4 builds in parallel). scope.ts (W3-4)
 * builds it from the state and the LibraryIndex.
 *
 * `studyEligible` takes this ctx PLUS `explicitDecks`: the decks the scope
 * query names (`explicitDecks(q, matchCtx)`, §4.1). A paused deck in that set
 * is still eligible (studied from its own deck page, or by a query that names it).
 */
export interface ScheduleCtx {
  /** The clock. Day boundaries (startOfLocalDay, dayKey) are derived from it. Buried = buriedUntil > now. */
  now: number;
  /** Every deck by id: order (round robin), options (caps, order, directions, checks), active. */
  decks: ReadonlyMap<Id, Deck>;
  /**
   * The card type (NoteType id) of a card, i.e. the `typeId` of its note.
   * `deck.options.directions` is keyed by card type, so the direction rule of
   * studyEligible needs it: a card is NOT eligible when
   * `deck.options.directions?.[typeIdOf(card)]` exists and does not contain
   * `card.ord`. No `directions`, or no entry for that card type = every ord
   * is enabled.
   * scope.ts passes `(card) => index.noteById.get(card.noteId)?.typeId`.
   * undefined = the note is unknown: the direction rule then does not apply.
   * (checkIntegrity keeps cards without a note out of state.cards, §3.5.)
   */
  typeIdOf: (card: Card) => Id | undefined;
  /**
   * Today's tallies. Callers pass the person's dayDone rolled over to the day
   * of `now`. A dayDone of another day must be read as all zeros.
   */
  done: DayDone;
  /** The settings the buckets read: daily limits (srs), session size, checks per day, sibling spacing. */
  settings: Pick<AppSettings, 'srs' | 'sessionLimit' | 'knownChecksPerDay' | 'spaceSiblings'>;
  /**
   * Sibling lookup over ALL cards (not only the pool), for the new-sibling and
   * review-sibling rules. A CardLookup (§4.4) fits this shape.
   */
  lookup: {
    cardById: ReadonlyMap<Id, Card>;
    cardIdsByNote: ReadonlyMap<Id, readonly Id[]>;
  };
  /**
   * Optional sort key for SortSpec `by: 'az'` and `by: 'field'`, which need
   * note text (scope.ts injects it from the LibraryIndex). The other sorts
   * use card fields only. Without it, 'az' and 'field' fall back to 'source'.
   */
  sortKey?: (card: Card, sort: SortSpec) => string | number;
  /**
   * Read ONLY by `selectPractice` (§6.6): the `life` and `flags` groups of the
   * practice query. When the query has `list`, the list's own groups count
   * too (so practising the Suspended list keeps its suspended cards). A whole
   * Query fits this type. selectPractice removes from the pool:
   *   - Known cards, unless `life` includes 'known';
   *   - Not started cards, unless `life` includes 'notStarted';
   *   - suspended cards, unless `flags` includes 'suspended';
   *   - buried cards, unless `flags` includes 'buried'.
   * Absent (for example a `sel` selection, "Practice the {n} you missed") =
   * remove all four.
   */
  scope?: Pick<Query, 'life' | 'flags'>;
}

/**
 * The buckets of one scheduled study run, AFTER every cap (daily limits and
 * session size). planQueue = [...learn, ...reviews, ...checks, ...fresh].
 */
export interface Selection {
  /** Learning cards that are due, by due. Never capped by the daily limit. */
  learn: Card[];
  /** Due Review/Mastered cards, by due, after the review-sibling rule and the review limit. */
  reviews: Card[];
  /** Known cards picked for one Check today. */
  checks: Card[];
  /** New cards for today (round robin over decks, new caps, new-sibling rule). */
  fresh: Card[];
  /** learn + reviews + checks + fresh BEFORE the session-size cut (daily limits already applied). */
  uncappedTotal: number;
}

/** The numbers on a Study button. total === planQueue(sel).length BY CONSTRUCTION. */
export interface ReadyCounts {
  /** Cards the session will show. "Study {total}". */
  total: number;
  /** = sel.learn.length. */
  learning: number;
  /** = sel.reviews.length. */
  due: number;
  /** = sel.checks.length. */
  checks: number;
  /** = sel.fresh.length. */
  neww: number;
  /** minutesFor(total). */
  mins: number;
  /** True when the session size cut cards (total < uncappedTotal). Then: "{uncappedTotal} ready · Study {total}". */
  capped: boolean;
  /** = sel.uncappedTotal. */
  uncappedTotal: number;
}

/* ---------------------------------------- facet fields (§4.3) ---------------------------------------- */

/**
 * One field-based filter group across the whole library (from
 * `fieldFacetSpecs`). Fields with the same FOLDED name in different card
 * types are ONE group (all German card types have `Level` → one Level group).
 * Whether the group is SHOWN is decided later, per scope (≥ 2 values there).
 */
export interface FacetFieldSpec {
  /** Folded field name, e.g. 'level'. The key in Query.fields; the facet key is `field:${key}`. */
  key: string;
  /** Display label: label ?? name of the first matching FieldDef. */
  label: string;
  /** Card type id → field index in that type. A FieldDef with facet 'off' is never listed. */
  fieldIndexByType: ReadonlyMap<Id, number>;
  /** Set when values hold several tokens ("regular, separable"): from FieldDef.multiSep or the multi-value rule. */
  multiSep?: ',' | ';' | '|';
  /** True when a FieldDef has facet 'on' (the data rule is skipped). False = it passed the 'auto' rule. */
  forced: boolean;
}

/* ---------------------------------------- backup file (§8.4) ---------------------------------------- */

/**
 * The backup file written by "Export a backup" and the weekly automatic backup.
 * `S` is the state shape: today's `DataState` by default; use `unknown` when
 * decoding, because restore runs `data` through the same `migrate()` as boot.
 * Old exports (a raw `DataState` JSON without this envelope) are accepted too.
 */
export interface BackupEnvelope<S = DataState> {
  format: 'maranki-backup';
  version: 1;
  /** schemaVersion of `data` when it was written. */
  schemaVersion: number;
  /** When the backup was written, epoch ms. */
  exportedAt: number;
  /** Which build wrote it: variant ('generic' | 'german') and app version. */
  app: { variant: string; version: string };
  data: S;
  /** The uncapped review history (from wave 3). */
  revlog?: RevlogRow[];
  /** Imported images (only when their total is ≤ 50 MB and "Include images" is on). */
  media?: { deckId: Id; name: string; base64: string }[];
}
