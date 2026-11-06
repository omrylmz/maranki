/**
 * Schema migration v2 → v3 (spec §3.5, unit W2-8): today's card model (each
 * card holds its own `front`/`back` text) → the note model of
 * src/domain/model.ts (the text lives in a NOTE; a card is one direction of
 * it). Pure: no I/O, and the clock comes in as `now`. LOSSLESS: every value a
 * schema-2 document holds has a place in the result.
 *
 * WIRED (W3-1): `migrate()` (src/store/migrate.ts) runs this step for every
 * document of schema 0, 1 or 2, so v3 is the live shape.
 *
 * THE ORDER OF THE CHAIN (`migrate()` runs ALL of it, in exactly this order):
 *
 *   v0toV2 / v1toV2 → sanitizeV2 → mergeDefaultsV2           ← migrateToV2(): the schema-2 stage
 *     → v2toV3 → checkIntegrity → sanitize (v3) → mergeDefaults (v3)
 *
 * WHY the v2 `sanitize` and `mergeDefaults` run BEFORE v2toV3: they repair the
 * card TEXT (`front: 42` → "42", `back: null` → "") and LIST each repair. After
 * v2toV3 the text is inside a note field, and nothing can tell a repaired ''
 * from a real ''. v2toV3 itself lists nothing. So if v2toV3 ran first, those
 * repairs would be silent (the learner would not be told). Spec §3.2 writes
 * the chain as "v0toV2 / v1toV2 → v2toV3 → checkIntegrity → sanitize →
 * mergeDefaults"; the `sanitize` and `mergeDefaults` there are the v3 ones,
 * and the v2 ones come first, as above.
 *
 * Input: a schema-2 document AFTER `sanitizeV2` + `mergeDefaultsV2` (what
 * `migrateToV2()` returns). NEVER a v3 state: `migrate()` already returns the
 * note model. On a damaged document it still never throws (a
 * text that is not a text becomes '', an entry that is not an object is
 * skipped), but it does not list repairs.
 *
 * What happens to each part (the table of spec §3.5):
 *   - every v2 card → ONE note + ONE card (ord 0). The card keeps its SAME id,
 *     so undo entries, the in-flight marker and any id in memory stay valid.
 *     Its SRS numbers, flags and `legacy` copy are copied unchanged.
 *   - a card with a `legacy` copy (a v2.0.x / German-fork card) → a note of a
 *     legacy vocabulary card type (German, Spanish, French or plain), so the
 *     Level, Type, Pronunciation and Example-translation fields come back;
 *     every other card → a note of the built-in Basic type.
 *   - decks get a list order, `source: 'migrated'`, default options and, for
 *     an old German/Spanish/French deck, its languages;
 *   - the saved filters (`collections`) → pinned built-in lists (`listPrefs`);
 *     `collections` itself stays until schema 4;
 *   - review-log entries get `seq`, `deckId` and `bucket`; today's tally gets
 *     `checks` and `newByDeck`; the settings get their seven new keys;
 *   - the in-flight session marker is kept AS IT IS, so the boot reconcile
 *     (M5) still banks a session that was killed before the update.
 *
 * Text: v2 texts are PLAIN text, but v3 note fields hold HTML (spec §3.4
 * "RAW text, may contain Anki HTML"; §5.7: plain text is escaped when it is
 * stored). `fieldText()` changes only what HTML would misread, so the learner
 * sees exactly what they saw before ("die Stunde" stays "die Stunde").
 *
 * Example (the order above; `migrate()` does all of it):
 *   const out = migrateToV2(JSON.parse(storedText), now);      // any old document → schema 2, repaired
 *   if (out.kind === 'ok') {
 *     const v3 = v2toV3(out.state, now);                        // → the note model
 *     const checked = checkIntegrity(v3, now);                  // → relations checked
 *     const repaired = [...out.repaired, ...checked.repaired];  // every repair, in order
 *   }
 */
import { BUILTIN_TYPE_IDS, BUILTIN_TYPE_KINDS, builtinType, type BuiltinTypeKind } from '../domain/builtinTypes';
import { makeCard, makeDeck, makeNote } from '../domain/makeV3';
import type * as v3 from '../domain/model';
import { foldText } from '../domain/text';
import { DEFAULT_SRS, type DataStateV2, type LegacyCardV0 } from '../domain/types';

/**
 * The schema-2 document. Since W3-1 `DataState` is the v3 shape, and the v2
 * shapes are kept in src/domain/types.ts as `…V2` for the migration.
 */
export type { DataStateV2 };

type CardV2 = DataStateV2['cards'][number];
type DeckV2 = DataStateV2['decks'][number];
type ReviewLogEntryV2 = DataStateV2['reviewLog'][number];
type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
/** A whole number ≥ 0. */
const isCount = (v: unknown): v is number => isFiniteNum(v) && Number.isInteger(v) && v >= 0;

/** The schema version this step writes. */
const V3 = 3;

/* ------------------------------------------------------------------ text */

/**
 * A v2 PLAIN text → a v3 field (HTML). Only what HTML would misread changes:
 *   - `<` → `&lt;` and `>` → `&gt;`: a `<` starts a tag, and the renderer
 *     drops tags ("List<String>" would show as "List");
 *   - a line break → `<br>`: HTML shows a line break as a space, so a
 *     multi-line note would become one line.
 * Every other character stays byte for byte. `&` stays too: a lone "&" shows
 * as itself, and an entity such as "&sum;" (the old importer left a few
 * undecoded) stays an entity, so a renderer that knows it shows the symbol.
 * A value that is not a text becomes `String(value ?? '')`, like `sanitize`.
 *
 *   fieldText('die Stunde')     → 'die Stunde'
 *   fieldText('List<String>')   → 'List&lt;String&gt;'
 *   fieldText('line 1\nline 2') → 'line 1<br>line 2'
 */
export function fieldText(value: unknown): string {
  const text = isString(value) ? value : String(value ?? '');
  return text.replace(/\r\n|[\r\n<>]/g, (ch) => (ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : '<br>'));
}

/* -------------------------------------------------------------- languages */

/** The three languages that have their own legacy card type. */
export type LegacyLang = 'de' | 'es' | 'fr';

const LEGACY_LANGS: Readonly<
  Record<LegacyLang, { names: readonly string[]; kind: BuiltinTypeKind; bcp47: string }>
> = {
  de: { names: ['german', 'deutsch'], kind: 'legacyVocabDe', bcp47: 'de-DE' },
  es: { names: ['spanish', 'espanol'], kind: 'legacyVocabEs', bcp47: 'es-ES' },
  fr: { names: ['french', 'francais'], kind: 'legacyVocabFr', bcp47: 'fr-FR' },
};

/**
 * The language of a schema-0 `lang` value, when it is German, Spanish or
 * French; else null. v0 CARDS store a code ('de'), v0 DECKS a name
 * ('German'), so both forms are read (and 'de-DE', 'Deutsch', 'Español' …).
 *
 *   legacyLangOf('de') → 'de'   legacyLangOf('Spanish') → 'es'   legacyLangOf('it') → null
 */
export function legacyLangOf(value: unknown): LegacyLang | null {
  if (!isString(value)) return null;
  const folded = foldText(value.trim());
  const code = folded.split(/[-_\s]/)[0];
  for (const lang of Object.keys(LEGACY_LANGS) as LegacyLang[]) {
    if (code === lang || LEGACY_LANGS[lang].names.includes(folded)) return lang;
  }
  return null;
}

/** The answer language of every legacy deck: the old app translated into English. */
const LEGACY_MEANING_LANG = 'en-US';

/* ------------------------------------------------------------- notes */

/**
 * The `notes` text that v0toV2 BUILT from the IPA and the example translation
 * (migrate.ts, cardFromV0). Both values now have their own fields, so a
 * `notes` equal to this text is not the learner's own note.
 */
function autoJoinedNotes(legacy: Partial<LegacyCardV0>): string {
  return [legacy.ipa, legacy.exTr].filter((v): v is string => isString(v) && v.trim() !== '').join('\n');
}

/**
 * The fields of a legacy vocabulary note, in the order of builtinTypes.ts
 * `legacyFields`: Word · Translation · Example · Example translation ·
 * Pronunciation · Level · Type · Article · Base · Notes.
 *
 *   - Word = `card.front`, not `legacy.word`: the learner may have edited it
 *     in v2. `front` is already the full form ("die Stunde"), so the article
 *     is never added a second time.
 *   - Example = `card.example` only, never `legacy.ex`, for the same reason:
 *     v0toV2 copied every example with text into `card.example`, so a v2
 *     card WITHOUT `example` is one whose example the learner cleared in the
 *     card editor (or whose `ex` was only spaces). The learner saw no example
 *     in v2, so the note has none either. The raw text stays in `legacy.ex`.
 *     (Spec §3.5 says `card.example ?? legacy.ex ?? ''`; that would bring a
 *     cleared example back.)
 *   - Notes = `card.notes`, unless it is only the auto-joined IPA + example
 *     translation (then '': both have their own fields now).
 */
function legacyNoteFields(card: CardV2, legacy: Partial<LegacyCardV0>): string[] {
  const notes = isString(card.notes) ? card.notes : '';
  return [
    card.front,
    card.back,
    card.example ?? '',
    legacy.exTr ?? '',
    legacy.ipa ?? '',
    legacy.level ?? '',
    legacy.type ?? '',
    legacy.article ?? '',
    legacy.base ?? '',
    notes === autoJoinedNotes(legacy) ? '' : notes,
  ].map(fieldText);
}

/** The fields of a Basic note: Front · Back · Example · Notes. */
function basicNoteFields(card: CardV2): string[] {
  return [card.front, card.back, card.example ?? '', card.notes ?? ''].map(fieldText);
}

/** The card type of a v2 card: a legacy type by `legacy.lang`, else Basic. */
function typeKindOf(card: CardV2): BuiltinTypeKind {
  if (!isObj(card.legacy)) return 'basic';
  const lang = legacyLangOf(card.legacy.lang);
  return lang ? LEGACY_LANGS[lang].kind : 'legacyVocab';
}

/* ------------------------------------------------------------- cards */

/**
 * The card keys copied unchanged from v2 to v3 (spec §3.5: "SRS and flags
 * unchanged, legacy kept"). Picked ONE BY ONE: makeV3.makeCard keeps every
 * key it is given, and the v2 text keys (`front`, `back`, `example`,
 * `notes`, `tags`) must not stay on a v3 card — they live in the note now.
 */
const KEPT_CARD_KEYS = [
  'fav',
  'flagged',
  'suspended',
  'buriedUntil',
  'ease',
  'intervalDays',
  'stepIndex',
  'reps',
  'lapses',
  'due',
  'createdAt',
  'lastReviewedAt',
  'legacy',
] as const satisfies readonly (keyof CardV2 & keyof v3.Card)[];

/** The keys of `obj` in `keys` whose value is not `undefined` (JSON would drop an `undefined`). */
function pick<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Partial<Pick<T, K>> {
  const out: Partial<Pick<T, K>> = {};
  for (const key of keys) {
    if (obj[key] !== undefined) out[key] = obj[key];
  }
  return out;
}

/** `${base}~2`, `${base}~3` … — the first one not in `used`. */
function freshId(base: string, used: ReadonlySet<string>): string {
  let k = 2;
  while (used.has(`${base}~${k}`)) k += 1;
  return `${base}~${k}`;
}

/**
 * One v2 card → its note and its v3 card (spec §3.5).
 *   note: id 'n-' + card id, guid 'm-' + card id, section '' (no subdeck),
 *         order = createdAt, source 'migrated', tags = card.tags;
 *   card: the same id, ord 0, newPos = createdAt, SRS + flags + legacy unchanged.
 */
function migrateCard(
  card: CardV2,
  id: string,
  ctx: { now: number; startingEase: number },
): { note: v3.Note; card: v3.Card; kind: BuiltinTypeKind } {
  const kind = typeKindOf(card);
  const createdAt = isFiniteNum(card.createdAt) ? card.createdAt : ctx.now;
  const note = makeNote(
    {
      id: `n-${id}`,
      typeId: BUILTIN_TYPE_IDS[kind],
      fields: kind === 'basic' ? basicNoteFields(card) : legacyNoteFields(card, card.legacy ?? {}),
      tags: Array.isArray(card.tags) ? card.tags.filter(isString) : [],
      section: '',
      guid: `m-${id}`,
      order: createdAt,
      source: { kind: 'migrated' },
      // When the item was made. A migration is not an edit, so updatedAt is the same.
      createdAt,
      updatedAt: createdAt,
    },
    ctx.now,
  );
  const v3Card = makeCard(note, 0, card.deckId, { startingEase: ctx.startingEase }, ctx.now, {
    ...pick(card, KEPT_CARD_KEYS),
    id,
    newPos: note.order,
  });
  return { note, card: v3Card, kind };
}

/* ------------------------------------------------------------- decks */

/** The deck order: by `createdAt`, oldest first; equal times keep the list order. */
function deckOrders(decks: readonly DeckV2[]): Map<DeckV2, number> {
  const time = (d: DeckV2) => (isFiniteNum(d.createdAt) ? d.createdAt : Number.MAX_SAFE_INTEGER);
  const sorted = decks.map((deck, index) => ({ deck, index }));
  sorted.sort((a, b) => time(a.deck) - time(b.deck) || a.index - b.index);
  return new Map(sorted.map(({ deck }, order) => [deck, order]));
}

/**
 * One v2 deck → a v3 deck (spec §3.5): the same id, name, icon, description,
 * pause state, createdAt, `builtin` and `legacy` copy; plus `order`,
 * `source: 'migrated'`, `defaultTypeId: 'nt-basic'` and the default options
 * (no per-deck new cap, source order, new cards queued, Known checks on).
 * An old German/Spanish/French deck (`legacy.lang`) also gets its language,
 * English answers, and the German article colours for German.
 */
function migrateDeck(deck: DeckV2, index: number, order: number, now: number): v3.Deck {
  const lang = legacyLangOf(isObj(deck.legacy) ? deck.legacy.lang : undefined);
  return makeDeck(
    {
      // The same rule as sanitize: a deck with no id gets 'deck-repaired-<index>'.
      id: isString(deck.id) && deck.id !== '' ? deck.id : `deck-repaired-${index}`,
      name: isString(deck.name) ? deck.name : String(deck.name ?? ''),
      // undefined = makeDeck's default (icon 🗂️, active, createdAt now).
      icon: isString(deck.icon) ? deck.icon : undefined,
      desc: isString(deck.desc) ? deck.desc : undefined,
      active: isBool(deck.active) ? deck.active : undefined,
      createdAt: isFiniteNum(deck.createdAt) ? deck.createdAt : undefined,
      builtin: isBool(deck.builtin) ? deck.builtin : undefined,
      legacy: isObj(deck.legacy) ? deck.legacy : undefined,
      order,
      source: 'migrated',
      defaultTypeId: BUILTIN_TYPE_IDS.basic,
      ...(lang
        ? {
            language: LEGACY_LANGS[lang].bcp47,
            meaningLanguage: LEGACY_MEANING_LANG,
            ...(lang === 'de' ? { genderColors: true } : {}),
          }
        : {}),
    },
    now,
  );
}

/* ------------------------------------------------------- lists, log, settings */

/** A v2 collection (saved filter) → the built-in list that replaces it (spec §4.7). By query… */
const LIST_BY_QUERY: ReadonlyMap<string, string> = new Map([
  ['hardest', 'builtin:hard'],
  ['favorites', 'builtin:favorites'],
  ['young', 'builtin:recent'],
  ['flagged', 'builtin:flagged'],
]);
/** …or, for an unknown query, by the seed's collection id. */
const LIST_BY_SEED_ID: ReadonlyMap<string, string> = new Map([
  ['hard', 'builtin:hard'],
  ['fav', 'builtin:favorites'],
  ['daily', 'builtin:recent'],
]);

/**
 * Every v2 collection → a PINNED built-in list, in the collections' order
 * (spec §3.5). A second collection for the same list adds nothing.
 */
function listPrefsOf(collections: readonly unknown[]): Record<string, v3.ListPref> {
  const prefs: Record<string, v3.ListPref> = {};
  let order = 0;
  for (const c of collections) {
    if (!isObj(c)) continue;
    const listId =
      (isString(c.query) ? LIST_BY_QUERY.get(c.query) : undefined) ??
      (isString(c.id) ? LIST_BY_SEED_ID.get(c.id) : undefined);
    if (!listId || listId in prefs) continue;
    prefs[listId] = { pinned: true, hidden: false, order };
    order += 1;
  }
  return prefs;
}

/** The SRS keys of a v2 undo snapshot. v3 adds `knownAt` and `knownCheckedAt` (both null: v2 has no Known). */
const PREV_KEYS = ['ease', 'intervalDays', 'stepIndex', 'reps', 'lapses', 'due', 'lastReviewedAt'] as const;

/**
 * One v2 review-log entry → v3 (spec §3.5): `seq` = its position (1, 2, 3 …),
 * `deckId` = the deck of its card ('' when the card is gone), `bucket` from
 * `wasNew` ('new' or 'review'), and `prev` + `knownAt: null, knownCheckedAt: null`.
 * `wasNew` itself is not kept: `bucket` replaces it.
 */
function migrateLogEntry(entry: ReviewLogEntryV2, seq: number, deckOfCard: ReadonlyMap<string, string>): v3.ReviewLogEntry {
  const prev = isObj(entry.prev) ? (entry.prev as ReviewLogEntryV2['prev']) : ({} as ReviewLogEntryV2['prev']);
  return {
    id: entry.id,
    seq,
    cardId: entry.cardId,
    deckId: deckOfCard.get(entry.cardId) ?? '',
    rating: entry.rating,
    atMs: entry.atMs,
    bucket: entry.wasNew === true ? 'new' : 'review',
    prev: { ...(pick(prev, PREV_KEYS) as ReviewLogEntryV2['prev']), knownAt: null, knownCheckedAt: null },
  };
}

/** The settings schema 3 adds (spec §3.5), with their defaults. */
const NEW_SETTINGS = {
  reminderSkipStudied: true,
  spaceSiblings: true,
  knownChecksPerDay: 5,
  autoBackup: true,
  lastAutoBackupAt: null,
  backupImages: true,
  reminderOfferSeen: false,
} as const satisfies Partial<v3.AppSettings>;

/**
 * v2 settings + the seven new keys. Every v2 key is kept (`sessionLimit`,
 * `reminderTime`, and unknown keys such as v0's `pronunciationPrompt`). A new
 * key that a wave-2 build already stored with the right kind of value keeps
 * that value (for example `lastAutoBackupAt`); otherwise it gets its default.
 */
function migrateSettings(settings: DataStateV2['settings']): v3.AppSettings {
  const stored = (isObj(settings) ? settings : {}) as Obj;
  const keep = <K extends keyof typeof NEW_SETTINGS>(key: K, ok: (v: unknown) => boolean) =>
    (ok(stored[key]) ? stored[key] : NEW_SETTINGS[key]) as v3.AppSettings[K];
  return {
    ...(stored as unknown as v3.AppSettings),
    reminderSkipStudied: keep('reminderSkipStudied', isBool),
    spaceSiblings: keep('spaceSiblings', isBool),
    knownChecksPerDay: keep('knownChecksPerDay', isCount),
    autoBackup: keep('autoBackup', isBool),
    lastAutoBackupAt: keep('lastAutoBackupAt', (v) => v === null || isFiniteNum(v)),
    backupImages: keep('backupImages', isBool),
    reminderOfferSeen: keep('reminderOfferSeen', isBool),
  };
}

/* ---------------------------------------------------------------- v2 → v3 */

const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

/**
 * Schema 2 → schema 3 (spec §3.5). See the file comment for what happens to
 * each part. Unknown top-level keys survive. The result's version fields are
 * 3 / 3: schema 3 removes `front`/`back` from cards, so an older app must
 * not read it (spec §3.1 rule 1).
 *
 * Card ids are kept. Only when two v2 cards share ONE id (the old store never
 * made that, but a damaged document could have it) does the second card get
 * a new id ('<id>~2'), so neither card nor its text is lost. The new id is
 * never an id that another card of the list already has: that card keeps it.
 */
export function v2toV3(doc: DataStateV2, now: number): v3.DataStateV3 {
  const raw = doc as unknown as Obj;
  const srs = isObj(doc.settings) && isObj(doc.settings.srs) ? doc.settings.srs : DEFAULT_SRS;
  const ctx = { now, startingEase: isFiniteNum(srs.startingEase) ? srs.startingEase : DEFAULT_SRS.startingEase };

  // Cards → one note + one card each.
  const notes: v3.Note[] = [];
  const cards: v3.Card[] = [];
  const kindsUsed = new Set<BuiltinTypeKind>();
  const cardsIn = list<CardV2>(raw.cards);
  // `taken`: every id of the list, so a new id never takes the id of a later card.
  const taken = new Set(cardsIn.filter(isObj).map((c) => c.id).filter(isString));
  const given = new Set<string>();
  cardsIn.forEach((card, index) => {
    if (!isObj(card)) return;
    // The same rule as sanitize: a card with no id gets 'card-repaired-<index>'.
    const own = isString(card.id) && card.id !== '' ? card.id : `card-repaired-${index}`;
    const id = given.has(own) ? freshId(own, taken) : own;
    given.add(id);
    taken.add(id);
    const out = migrateCard(card, id, ctx);
    notes.push(out.note);
    cards.push(out.card);
    kindsUsed.add(out.kind);
  });

  // The built-in card types the notes use, in the fixed built-in order.
  const noteTypes = BUILTIN_TYPE_KINDS.filter((kind) => kindsUsed.has(kind)).map((kind) => builtinType(kind, now));

  const decksV2 = list<DeckV2>(raw.decks).filter(isObj);
  const orders = deckOrders(decksV2);
  const decks = decksV2.map((deck, index) => migrateDeck(deck, index, orders.get(deck) ?? 0, now));

  // The first card with an id wins: review entries point at the card that kept the id.
  const deckOfCard = new Map<string, string>();
  for (const card of cards) if (!deckOfCard.has(card.id)) deckOfCard.set(card.id, card.deckId);
  const reviewLog = list<ReviewLogEntryV2>(raw.reviewLog)
    .filter(isObj)
    .map((entry, i) => migrateLogEntry(entry, i + 1, deckOfCard));

  const person = (isObj(doc.person) ? doc.person : {}) as DataStateV2['person'];
  const dayDone = (isObj(person.dayDone) ? person.dayDone : {}) as DataStateV2['person']['dayDone'];

  return {
    ...(doc as unknown as Partial<v3.DataStateV3>),
    schemaVersion: V3,
    minReaderVersion: V3,
    noteTypes,
    notes,
    cards,
    decks,
    lists: [],
    listPrefs: listPrefsOf(list(raw.collections)),
    person: { ...person, dayDone: { ...dayDone, checks: 0, newByDeck: {} } },
    sessions: list(raw.sessions),
    reviewLog,
    manualLog: [],
    settings: migrateSettings(doc.settings),
    onboarded: doc.onboarded,
    // Kept AS IT IS: the boot reconcile (M5) still banks it after the update.
    inProgressSession: doc.inProgressSession ?? null,
    pack: null,
    // Kept until schema 4 (nothing reads it after wave 4).
    collections: list(raw.collections),
  };
}
