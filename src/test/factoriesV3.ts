/**
 * Test factories for the v3 NOTE MODEL (spec §3.4, unit W2-7): small builders
 * for valid v3 objects, a validity check, a seeded random library, and two
 * helpers for pure-command tests (a test ctx and a deep read-only view).
 *
 * WHY a second file: src/test/factories.ts builds TODAY's v2 shapes (cards
 * with front/back). The v3 shapes (src/domain/model.ts) are different: a card
 * has no text, it points at a note. These builders use the real v3
 * constructors (makeV3.ts) and the real built-in card types
 * (builtinTypes.ts), so a factory object looks exactly like one the app makes.
 *
 * Rules the builders keep:
 *   - no key ever holds `undefined` (JSON would drop it, and deep-equal fails);
 *   - the same input (and the same seed for `randomStateV3`) gives the same output.
 *
 * Example:
 *   const deck = makeDeckV3({ id: 'd1' });
 *   const { note, cards } = noteWithCards({ deckId: 'd1', typeId: BUILTIN_TYPE_IDS.basicReverse, ords: [0, 1] });
 *   const state = stateOfV3({ decks: [deck], groups: [{ note, cards }] });
 *   expect(stateProblemsV3(state)).toEqual([]);
 */
import { BUILTIN_TYPE_IDS, builtinKindOf, builtinType } from '../domain/builtinTypes';
import { clozeOrds } from '../domain/noteOps';
import {
  MANUAL_LOG_MAX_EDITS,
  MANUAL_LOG_MAX_SNAPSHOTS,
  type OpCtx,
  snapshotCount,
} from '../domain/manualLog';
import { makeCard, makeDeck, makeNote } from '../domain/makeV3';
import type {
  AppSettings,
  Card,
  DataStateV3,
  Deck,
  DeckOptions,
  Id,
  LifeKey,
  Note,
  NoteType,
  Person,
} from '../domain/model';
import { buildSeedState } from '../domain/seed';
import { DAY, dayKeyOf, DEFAULT_APP_SETTINGS, DEFAULT_SRS, MIN } from '../domain/types';
import { FIXED_NOW } from './clock';
import type { Random } from './random';

/** The id of the deck that `makeCardV3()` and `noteWithCards()` use when the test gives none. */
export const DEFAULT_DECK_ID_V3 = 'deck-1';

/* ------------------------------------------------------------------ ids */

let idCounter = 0;

/** A new id like 'note-7'. Unique inside one test file (jest gives every file fresh modules). */
export function nextIdV3(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

/**
 * A command ctx for tests: a FIXED clock and an id maker in the same format
 * family as the app's ('c-t12'). All ctx objects of one test file share one
 * counter, so two of them never make the same id.
 */
export function testCtx(now: number = FIXED_NOW): OpCtx {
  return { now, newId: (prefix) => nextIdV3(`${prefix}-t`) };
}

/* ------------------------------------------------------- read-only view */

/** target object → its read-only view (and a view → itself), so one object always has ONE view. */
const views = new WeakMap<object, object>();

/** The error a write through a read-only view throws. */
function inPlaceChange(key: PropertyKey): never {
  throw new TypeError(`in-place change of "${String(key)}": a pure command must build new objects`);
}

/**
 * A deep READ-ONLY view of a value: any write, delete or new property on it
 * (or on any object inside it) THROWS. So a pure command that changes its
 * input in place fails the test, instead of passing by luck.
 *
 * WHY not `Object.freeze`: jest-expo compiles the code WITHOUT strict mode,
 * and outside strict mode a write to a frozen object is silently ignored —
 * the test would never notice. A Proxy trap throws in every mode.
 *
 * Reads work as usual (`map`, spread, JSON, toEqual). One object always gives
 * the same view, so identity checks (`toBe`) between views work. Compare
 * views with views: an object read through the view is the view, not the
 * raw object.
 */
export function deepReadOnly<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  const target = value as object;
  const known = views.get(target);
  if (known) return known as T;
  const view = new Proxy(target, {
    get: (t, key, receiver) => deepReadOnly(Reflect.get(t, key, receiver)),
    set: (_t, key) => inPlaceChange(key),
    defineProperty: (_t, key) => inPlaceChange(key),
    deleteProperty: (_t, key) => inPlaceChange(key),
    setPrototypeOf: () => inPlaceChange('prototype'),
  });
  views.set(target, view);
  views.set(view, view);
  return view as T;
}

/* --------------------------------------------------------------- builders */

/**
 * v3 settings: today's real defaults (DEFAULT_APP_SETTINGS) plus the keys v3
 * adds, with the values of the v2 → v3 mapping (spec §3.5). `srs` is merged
 * key by key.
 */
export function makeSettingsV3(
  overrides: Partial<Omit<AppSettings, 'srs'>> & { srs?: Partial<AppSettings['srs']> } = {},
): AppSettings {
  // A deep copy, so a test can never change the shared DEFAULT_* objects.
  const defaults = JSON.parse(JSON.stringify(DEFAULT_APP_SETTINGS)) as typeof DEFAULT_APP_SETTINGS;
  const { srs, ...rest } = overrides;
  return {
    ...defaults,
    reminderSkipStudied: true,
    spaceSiblings: true,
    knownChecksPerDay: 5,
    autoBackup: true,
    lastAutoBackupAt: null,
    backupImages: true,
    reminderOfferSeen: false,
    ...rest,
    srs: { ...defaults.srs, ...srs },
  };
}

/** A learner who has not studied yet (the seed person, with the v3 day tally), plus overrides. */
export function makePersonV3(overrides: Partial<Person> = {}, now: number = FIXED_NOW): Person {
  const seed = buildSeedState(now).person;
  return {
    ...seed,
    dayDone: { dayKey: dayKeyOf(now), reviews: 0, neww: 0, checks: 0, newByDeck: {} },
    ...overrides,
  };
}

/** A whole v3 state: an empty library with every default, plus overrides. */
export function makeStateV3(overrides: Partial<DataStateV3> = {}, now: number = FIXED_NOW): DataStateV3 {
  return {
    schemaVersion: 3,
    minReaderVersion: 3,
    noteTypes: [],
    notes: [],
    cards: [],
    decks: [],
    lists: [],
    listPrefs: {},
    person: makePersonV3({}, now),
    sessions: [],
    reviewLog: [],
    manualLog: [],
    settings: makeSettingsV3(),
    onboarded: true,
    inProgressSession: null,
    pack: null,
    collections: [],
    ...overrides,
  };
}

/** A deck made by the real makeDeck (makeV3.ts). `options` may be partial. */
export function makeDeckV3(
  overrides: Partial<Omit<Deck, 'options'>> & { options?: Partial<DeckOptions> } = {},
): Deck {
  return makeDeck({ id: overrides.id ?? nextIdV3('deck'), name: 'Test deck', ...overrides }, FIXED_NOW);
}

/** A note made by the real makeNote: a Basic note 'front' / 'back' unless the test says otherwise. */
export function makeNoteV3(overrides: Partial<Note> = {}): Note {
  return makeNote(
    {
      id: overrides.id ?? nextIdV3('note'),
      typeId: BUILTIN_TYPE_IDS.basic,
      fields: ['front', 'back', '', ''],
      createdAt: FIXED_NOW,
      ...overrides,
    },
    FIXED_NOW,
  );
}

/**
 * A brand-new card made by the real makeCard (New, reps 0, due = createdAt).
 * `noteId`, `deckId` and `ord` default to a fresh note id, DEFAULT_DECK_ID_V3 and 0;
 * `newPos` defaults to `createdAt` (a note's default order).
 */
export function makeCardV3(overrides: Partial<Card> = {}): Card {
  const createdAt = overrides.createdAt ?? FIXED_NOW;
  const { noteId, deckId, ord, ...rest } = overrides;
  return makeCard(
    { id: noteId ?? nextIdV3('note'), order: overrides.newPos ?? createdAt },
    ord ?? 0,
    deckId ?? DEFAULT_DECK_ID_V3,
    DEFAULT_SRS,
    createdAt,
    { id: overrides.id ?? nextIdV3('card'), createdAt, ...rest },
  );
}

/**
 * The SRS values of a card in one status (`life(card)` returns `kind`). Not
 * due yet: learning → in 10 minutes, review → in 3 days, mastered → in 20
 * days. Known = never studied, marked known a day ago.
 */
export function lifeValues(kind: LifeKey, now: number = FIXED_NOW): Partial<Card> {
  switch (kind) {
    case 'notStarted':
      return { reps: 0, lapses: 0, stepIndex: null, intervalDays: 0, due: now, lastReviewedAt: null, newState: 'notStarted' };
    case 'new':
      return { reps: 0, lapses: 0, stepIndex: null, intervalDays: 0, due: now, lastReviewedAt: null };
    case 'learning':
      return { reps: 1, lapses: 0, stepIndex: 1, intervalDays: 0, due: now + 10 * MIN, lastReviewedAt: now - MIN };
    case 'review':
      return { reps: 4, lapses: 1, stepIndex: null, intervalDays: 6, ease: 2.35, due: now + 3 * DAY, lastReviewedAt: now - 3 * DAY };
    case 'mastered':
      return { reps: 9, lapses: 0, stepIndex: null, intervalDays: 34, ease: 2.65, due: now + 20 * DAY, lastReviewedAt: now - 14 * DAY };
    case 'known':
      return { reps: 0, lapses: 0, stepIndex: null, intervalDays: 0, due: now, lastReviewedAt: null, knownAt: now - DAY };
  }
}

/** A card in one status (see lifeValues), plus overrides. */
export function cardInLifeV3(kind: LifeKey, overrides: Partial<Card> = {}, now: number = FIXED_NOW): Card {
  return makeCardV3({ createdAt: now - 30 * DAY, ...lifeValues(kind, now), ...overrides });
}

export interface NoteWithCardsInput {
  deckId?: Id;
  typeId?: Id;
  /** Field values. Default: 'front <n>' / 'back <n>' and empty fields, as many as the type has. */
  fields?: string[];
  /** The directions to make cards for. Default: every template ord (cloze: the cloze numbers). */
  ords?: number[];
  /** Extra Note keys (id, tags, section, order …). */
  note?: Partial<Note>;
  /** Extra Card keys for every card, or per ord. */
  card?: Partial<Card> | ((ord: number) => Partial<Card>);
}

/** One note and its cards (siblings share newPos = note.order), for a built-in or given card type. */
export function noteWithCards(input: NoteWithCardsInput = {}, types: readonly NoteType[] = []): { note: Note; cards: Card[] } {
  const typeId = input.typeId ?? BUILTIN_TYPE_IDS.basic;
  const type = typeById(typeId, types);
  const id = input.note?.id ?? nextIdV3('note');
  const fields =
    input.fields ?? type.fields.map((_, i) => (i === 0 ? `front ${id}` : i === 1 ? `back ${id}` : ''));
  const note = makeNoteV3({ ...input.note, id, typeId, fields });
  const ords =
    input.ords ?? (type.kind === 'cloze' ? clozeOrds(type, fields) : type.templates.map((t) => t.ord));
  const cards = ords.map((ord) => {
    const extra = typeof input.card === 'function' ? input.card(ord) : input.card;
    // The note, deck and ord always win: a card of this note must point at it.
    return makeCardV3({ newPos: note.order, ...extra, noteId: note.id, deckId: input.deckId ?? DEFAULT_DECK_ID_V3, ord });
  });
  return { note, cards };
}

/** A card type by id: one of `types`, or a built-in one. Throws on an unknown id (a test typo). */
function typeById(typeId: Id, types: readonly NoteType[]): NoteType {
  const given = types.find((t) => t.id === typeId);
  if (given) return given;
  const kind = builtinKindOf(typeId);
  if (!kind) throw new Error(`factoriesV3: unknown card type ${typeId}`);
  return builtinType(kind, FIXED_NOW);
}

/**
 * A v3 state from decks and note groups. `noteTypes` defaults to the
 * built-in types the notes use (plus every type in `types`).
 */
export function stateOfV3(input: {
  decks: Deck[];
  groups?: { note: Note; cards: Card[] }[];
  types?: NoteType[];
  overrides?: Partial<DataStateV3>;
}): DataStateV3 {
  const groups = input.groups ?? [];
  const types = [...(input.types ?? [])];
  for (const { note } of groups) {
    if (!types.some((t) => t.id === note.typeId)) types.push(typeById(note.typeId, []));
  }
  return makeStateV3({
    decks: input.decks,
    noteTypes: types,
    notes: groups.map((g) => g.note),
    cards: groups.flatMap((g) => g.cards),
    ...input.overrides,
  });
}

/* --------------------------------------------------------- validity check */

const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Everything that makes `state` break a v3 invariant, as readable lines (an
 * empty list = valid). Checks:
 *   - unique ids (decks, card types, notes, cards);
 *   - every card: its note and its deck exist (no orphan); a whole-number ord;
 *     finite SRS numbers; no `undefined` key;
 *   - one card per (note, ord), and ALL cards of one note in ONE deck;
 *   - every note: its card type exists, and the field list fits the type;
 *   - the manual log is inside its caps.
 */
export function stateProblemsV3(state: Pick<DataStateV3, 'noteTypes' | 'notes' | 'cards' | 'decks' | 'manualLog'>): string[] {
  const out: string[] = [];
  const unique = (what: string, ids: string[]) => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) out.push(`${what} id ${id} is used twice`);
      seen.add(id);
    }
    return seen;
  };
  const deckIds = unique('deck', state.decks.map((d) => d.id));
  const types = new Map(state.noteTypes.map((t) => [t.id, t]));
  unique('card type', state.noteTypes.map((t) => t.id));
  const noteIds = unique('note', state.notes.map((n) => n.id));
  unique('card', state.cards.map((c) => c.id));

  for (const note of state.notes) {
    const type = types.get(note.typeId);
    if (!type) out.push(`note ${note.id}: card type ${note.typeId} is missing`);
    else if (note.fields.length !== type.fields.length) {
      out.push(`note ${note.id}: ${note.fields.length} fields, its type has ${type.fields.length}`);
    }
    if (!Array.isArray(note.tags)) out.push(`note ${note.id}: tags is not a list`);
  }

  const deckOfNote = new Map<Id, Id>();
  const ordsOfNote = new Map<Id, Set<number>>();
  for (const card of state.cards) {
    const at = `card ${card.id}`;
    for (const [key, value] of Object.entries(card)) if (value === undefined) out.push(`${at}: ${key} is undefined`);
    if (!noteIds.has(card.noteId)) out.push(`${at}: note ${card.noteId} is missing`);
    if (!deckIds.has(card.deckId)) out.push(`${at}: deck ${card.deckId} is missing (orphan)`);
    if (!Number.isInteger(card.ord) || card.ord < 0) out.push(`${at}: ord ${card.ord}`);
    for (const key of ['ease', 'intervalDays', 'reps', 'lapses', 'due', 'createdAt', 'newPos'] as const) {
      if (!isFiniteNum(card[key])) out.push(`${at}: ${key} is ${String(card[key])}`);
    }
    const home = deckOfNote.get(card.noteId);
    if (home === undefined) deckOfNote.set(card.noteId, card.deckId);
    else if (home !== card.deckId) out.push(`note ${card.noteId}: cards in two decks (${home}, ${card.deckId})`);
    const ords = ordsOfNote.get(card.noteId) ?? new Set<number>();
    if (ords.has(card.ord)) out.push(`note ${card.noteId}: two cards for ord ${card.ord}`);
    ords.add(card.ord);
    ordsOfNote.set(card.noteId, ords);
  }

  if (state.manualLog.length > MANUAL_LOG_MAX_EDITS) out.push(`manualLog has ${state.manualLog.length} edits`);
  const snapshots = state.manualLog.reduce((sum, e) => sum + snapshotCount(e), 0);
  if (snapshots > MANUAL_LOG_MAX_SNAPSHOTS) out.push(`manualLog has ${snapshots} snapshots`);
  return out;
}

/**
 * The ids of the notes that have NO card. The Library lists cards, so such a
 * note is invisible. It is not a check in stateProblemsV3, because stored
 * data may have one (checkIntegrity keeps it, spec §3.5). But the note
 * commands promise never to MAKE one: a note that has a card keeps at least
 * one (noteOps.ts header).
 */
export function notesWithoutCards(state: Pick<DataStateV3, 'notes' | 'cards'>): Id[] {
  const withCards = new Set(state.cards.map((c) => c.noteId));
  return state.notes.filter((n) => !withCards.has(n.id)).map((n) => n.id);
}

/* ------------------------------------------------------- random states */

/**
 * A custom card type with three directions, so tests can turn single
 * directions on and off: Word (term), Meaning (meaning), Example (example).
 */
export function threeWayType(now: number = FIXED_NOW): NoteType {
  return {
    id: 'nt-three-way',
    name: 'Three ways',
    kind: 'standard',
    fields: [
      { name: 'Word', role: 'term', facet: 'off' },
      { name: 'Meaning', role: 'meaning', facet: 'off' },
      { name: 'Example', role: 'example', facet: 'off' },
    ],
    templates: [
      { ord: 0, name: 'Word → Meaning', prompt: [0], answer: [1, 2] },
      { ord: 1, name: 'Meaning → Word', prompt: [1], answer: [0, 2] },
      { ord: 2, name: 'Example → Word', prompt: [2], answer: [0, 1] },
    ],
    sortField: 0,
    createdAt: now,
    updatedAt: now,
  };
}

const LIFE_KINDS: readonly LifeKey[] = ['notStarted', 'new', 'learning', 'review', 'mastered', 'known'];
const WORDS = ['die Stunde', 'über', 'Straße', 'la cuchara', 'H2O', 'Topic alpha', 'Ottawa', 'kaufen', 'ça va', '東京'];
const TAGS = ['verb', 'A1', 'German::Verbs::B1', 'core', 'Algo::Core'];
const SECTIONS = ['', '', 'Verbs', 'Verbs::B1', 'Nouns::A1'];

export interface RandomStateV3Options {
  now?: number;
  /** Most decks (at least 1). Default 3. */
  maxDecks?: number;
  /** Most notes in the whole state. Default 25. */
  maxNotes?: number;
}

/**
 * A random but VALID v3 library: decks (some paused, some with "Not started"
 * arrival or turned-off directions), Basic, Basic + reverse, Cloze and a
 * three-direction type, notes with tags and sections, and cards in every
 * status (some favorite, flagged, suspended or buried). Ids depend only on
 * the generator, so the same seed gives a deep-equal state.
 */
export function randomStateV3(rnd: Random, options: RandomStateV3Options = {}): DataStateV3 {
  const now = options.now ?? FIXED_NOW;
  const types = [
    builtinType('basic', now),
    builtinType('basicReverse', now),
    builtinType('cloze', now),
    threeWayType(now),
  ];
  const decks: Deck[] = [];
  const deckCount = rnd.int(1, Math.max(1, options.maxDecks ?? 3));
  for (let i = 0; i < deckCount; i++) {
    const directions = rnd.bool(0.3) ? { 'nt-three-way': rnd.sample([0, 1, 2], rnd.int(1, 2)).sort() } : undefined;
    decks.push(
      makeDeckV3({
        id: `deck-${i + 1}`,
        name: `Deck ${i + 1}`,
        order: i,
        active: rnd.bool(0.85),
        createdAt: now - rnd.int(1, 100) * DAY,
        options: {
          newArrival: rnd.bool(0.3) ? 'notStarted' : 'queued',
          ...(directions ? { directions } : {}),
        },
      }),
    );
  }

  const groups: { note: Note; cards: Card[] }[] = [];
  const noteCount = rnd.int(0, Math.max(0, options.maxNotes ?? 25));
  for (let i = 0; i < noteCount; i++) {
    const deck = rnd.pick(decks);
    const type = rnd.pick(types);
    const word = `${rnd.pick(WORDS)} ${i + 1}`;
    let fields: string[];
    if (type.kind === 'cloze') {
      const numbers = rnd.sample([1, 2, 3], rnd.int(1, 3)).sort();
      fields = [numbers.map((n) => `{{c${n}::${word} ${n}}}`).join(' and '), ''];
    } else {
      fields = type.fields.map((_, f) => (f === 0 ? word : f === 1 ? `meaning ${i + 1}` : rnd.bool(0.3) ? `extra ${i + 1}` : ''));
    }
    const allOrds = type.kind === 'cloze' ? clozeOrds(type, fields) : type.templates.map((t) => t.ord);
    // Usually every direction; sometimes only some of them (as after an import with one direction).
    const ords = rnd.bool(0.75) ? allOrds : rnd.sample(allOrds, rnd.int(1, allOrds.length)).sort();
    const createdAt = now - rnd.int(1, 60) * DAY + i;
    groups.push(
      noteWithCards(
        {
          deckId: deck.id,
          typeId: type.id,
          fields,
          ords,
          note: {
            id: `note-${i + 1}`,
            createdAt,
            order: createdAt,
            tags: rnd.bool(0.4) ? rnd.sample(TAGS, rnd.int(1, 2)) : [],
            section: rnd.pick(SECTIONS),
          },
          card: (ord) => {
            const kind = rnd.pick(LIFE_KINDS);
            return {
              id: `card-${i + 1}-${ord}`,
              createdAt,
              ...lifeValues(kind, now),
              fav: rnd.bool(0.15),
              flagged: rnd.bool(0.1),
              suspended: rnd.bool(0.05),
              buriedUntil: rnd.bool(0.05) ? now + rnd.int(1, 20) * MIN : null,
            };
          },
        },
        types,
      ),
    );
  }
  return stateOfV3({ decks, groups, types });
}
