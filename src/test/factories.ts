/**
 * Test factories (spec W0-1): small builders for VALID store objects of
 * schema v2, a validity check, and loaders for the fixtures.
 *
 * WHY: every test used to write its own `makeCard`. Each copy guessed the
 * defaults a little differently, so a test could pass with a card the app
 * never creates. These builders copy the defaults of the real constructors
 * (DataContext.addCard / addDeck, buildSeedState, DEFAULT_APP_SETTINGS), so a
 * factory object looks exactly like an object the app makes.
 *
 * Schema v2 (spec §3.3) = the card-text shapes + `schemaVersion`,
 * `minReaderVersion` and `settings.autoReadAloud`. Since wave 3 (W3-1) the
 * live shape is the v3 note model, and types.ts keeps the v2 shapes as `…V2`
 * (CardV2, DataStateV2 …). This file builds those v2 shapes: they are the
 * INPUT of the migration tests (an old document). For v3 objects use
 * src/test/factoriesV3.ts. The builders take the values FROM the real
 * defaults (DEFAULT_APP_SETTINGS_V2, buildSeedState), never a copy here.
 *
 * Rules the builders keep (the round-trip tests depend on them):
 *   - no key ever holds `undefined` (JSON would drop it, and deep-equal fails);
 *   - every card points at a deck that exists in the same state;
 *   - the same input (and the same seed for `randomState`) gives the same output.
 *
 * Example:
 *   const deck = makeDeck({ id: 'd1' });
 *   const due = cardInState('review', { deckId: 'd1', due: FIXED_NOW - DAY });
 *   const state = makeState({ decks: [deck], cards: [due] });
 *   expect(stateProblems(state)).toEqual([]);
 */
import * as fs from 'fs';
import * as path from 'path';

import { buildSeedState } from '../domain/seed';
import {
  AppSettingsV2 as AppSettings,
  CardV2 as Card,
  CollectionQuery,
  DAY,
  DataStateV2,
  dayKeyOf,
  DeckV2 as Deck,
  DEFAULT_APP_SETTINGS_V2 as DEFAULT_APP_SETTINGS,
  DEFAULT_SRS,
  HOUR,
  InProgressSessionV2 as InProgressSession,
  MIN,
  PersonV2 as Person,
  Rating,
  ReviewLogEntryV2 as ReviewLogEntry,
  SessionKindV2 as SessionKind,
  SessionRecordV2 as SessionRecord,
  SrsSettings,
} from '../domain/types';
import { FIXED_NOW } from './clock';
import { Random } from './random';

/* ------------------------------------------------------------ v2 shapes */

export const SCHEMA_V2 = 2;

/** App settings of schema v2: the v2 settings, with `autoReadAloud` (spec §3.3). */
export type SettingsV2 = AppSettings;

/** The saved document of schema v2 (spec §3.3). */
export type StateV2 = DataStateV2;

/** The id of the deck that `makeCard()` uses when the test gives none. */
export const DEFAULT_DECK_ID = 'deck-1';

const RATINGS: readonly Rating[] = ['again', 'hard', 'good', 'easy'];
const SESSION_KINDS: readonly SessionKind[] = ['scheduled', 'ahead', 'cram', 'hardest', 'deck', 'collection'];
const COLLECTION_QUERIES: readonly CollectionQuery[] = ['hardest', 'favorites', 'young', 'flagged'];

/* ------------------------------------------------------------------ ids */

let idCounter = 0;

/** A new id like 'card-7'. Unique inside one test file (jest gives every file fresh modules). */
export function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

/** Start the `nextId` counter again (for a test that compares exact ids). */
export function resetFactoryIds(): void {
  idCounter = 0;
}

/* --------------------------------------------------------------- builders */

/** Settings with every default; `srs` is merged key by key. */
export function makeSettings(
  overrides: Partial<Omit<SettingsV2, 'srs'>> & { srs?: Partial<SrsSettings> } = {},
): SettingsV2 {
  // A deep copy, so a test can never change the shared DEFAULT_* objects.
  const defaults = JSON.parse(JSON.stringify(DEFAULT_APP_SETTINGS)) as AppSettings;
  const { srs, ...rest } = overrides;
  return {
    ...defaults,
    ...rest,
    srs: { ...defaults.srs, ...srs },
  };
}

/** A learner who has not studied yet (the seed person, with the v2 day tally), plus overrides. */
export function makePerson(overrides: Partial<Person> = {}, now: number = FIXED_NOW): Person {
  const { dayDone, ...seed } = buildSeedState(now).person;
  return { ...seed, dayDone: { dayKey: dayDone.dayKey, reviews: 0, neww: 0 }, ...overrides };
}

/** A deck with DataContext.addDeck's defaults. */
export function makeDeck(overrides: Partial<Deck> = {}): Deck {
  return {
    id: overrides.id ?? nextId('deck'),
    name: 'Test deck',
    icon: '🗂️',
    builtin: false,
    active: true,
    createdAt: FIXED_NOW,
    ...overrides,
  };
}

/** A brand-new card with DataContext.addCard's defaults (reps 0, due now). */
export function makeCard(overrides: Partial<Card> = {}): Card {
  const createdAt = overrides.createdAt ?? FIXED_NOW;
  return {
    id: overrides.id ?? nextId('card'),
    deckId: DEFAULT_DECK_ID,
    front: 'front',
    back: 'back',
    fav: false,
    flagged: false,
    suspended: false,
    buriedUntil: null,
    ease: DEFAULT_SRS.startingEase,
    intervalDays: 0,
    stepIndex: null,
    reps: 0,
    lapses: 0,
    due: createdAt,
    createdAt,
    lastReviewedAt: null,
    ...overrides,
  };
}

export type Lifecycle = 'new' | 'learning' | 'review' | 'mastered';

/**
 * A card in one lifecycle state, with SRS fields that fit together
 * (`lifecycleState(card)` returns `kind`). Not due yet unless `due` is given:
 * learning → in 10 minutes, review → in 3 days, mastered → in 20 days.
 */
export function cardInState(kind: Lifecycle, overrides: Partial<Card> = {}, now: number = FIXED_NOW): Card {
  const srs: Record<Lifecycle, Partial<Card>> = {
    new: { reps: 0, lapses: 0, stepIndex: null, intervalDays: 0, due: now, lastReviewedAt: null },
    learning: { reps: 1, lapses: 0, stepIndex: 1, intervalDays: 0, due: now + 10 * MIN, lastReviewedAt: now - MIN },
    review: { reps: 4, lapses: 1, stepIndex: null, intervalDays: 6, ease: 2.35, due: now + 3 * DAY, lastReviewedAt: now - 3 * DAY },
    mastered: { reps: 9, lapses: 0, stepIndex: null, intervalDays: 34, ease: 2.65, due: now + 20 * DAY, lastReviewedAt: now - 14 * DAY },
  };
  return makeCard({ createdAt: now - 30 * DAY, ...srs[kind], ...overrides });
}

/** A review-log entry for rating `card` — `prev` is the card's SRS before the rating. */
export function makeReviewLogEntry(
  card: Card,
  rating: Rating,
  overrides: Partial<ReviewLogEntry> = {},
): ReviewLogEntry {
  return {
    id: overrides.id ?? nextId('rl'),
    cardId: card.id,
    rating,
    atMs: FIXED_NOW,
    prev: {
      ease: card.ease,
      intervalDays: card.intervalDays,
      stepIndex: card.stepIndex,
      reps: card.reps,
      lapses: card.lapses,
      due: card.due,
      lastReviewedAt: card.lastReviewedAt,
    },
    wasNew: card.reps === 0,
    ...overrides,
  };
}

/** A finished session. `total` defaults to the sum of `counts`. */
export function makeSessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  const counts = overrides.counts ?? { again: 1, hard: 1, good: 3, easy: 1 };
  const atMs = overrides.atMs ?? FIXED_NOW;
  return {
    id: overrides.id ?? nextId('s'),
    dayKey: dayKeyOf(atMs),
    atMs,
    kind: 'scheduled',
    counts,
    total: counts.again + counts.hard + counts.good + counts.easy,
    bestRun: 3,
    xp: 30,
    ...overrides,
  };
}

/** An in-flight session marker (M5). It carries `studyDay` unless the test removes it. */
export function makeMarker(overrides: Partial<InProgressSession> = {}): InProgressSession {
  const counts = overrides.counts ?? { again: 0, hard: 1, good: 2, easy: 0 };
  return {
    kind: 'scheduled',
    label: 'All decks',
    counts,
    total: counts.again + counts.hard + counts.good + counts.easy,
    bestRun: 2,
    durationSec: 40,
    fastAnswers: 0,
    studyDay: dayKeyOf(FIXED_NOW),
    ...overrides,
  };
}

/**
 * A whole saved document of schema v2: the v2 parts of the real first-run
 * seed (collections, person, onboarded) + the v2 version fields +
 * `overrides` (each key replaces the seed's key).
 */
export function makeState(overrides: Partial<StateV2> = {}, now: number = FIXED_NOW): StateV2 {
  const seed = buildSeedState(now);
  return {
    schemaVersion: SCHEMA_V2,
    minReaderVersion: SCHEMA_V2,
    cards: [],
    decks: [],
    collections: seed.collections,
    person: makePerson({}, now),
    sessions: [],
    reviewLog: [],
    settings: makeSettings(),
    onboarded: seed.onboarded,
    inProgressSession: null,
    ...overrides,
  };
}

/* ------------------------------------------------------- random states */

const DECK_NAMES = ['Capitals', 'Kitchen words', 'Chemistry', 'Verbs', 'Patterns', 'Birds', 'Idioms'];
const DECK_ICONS = ['🗂️', '🌍', '🧪', '🇩🇪', '🧠', '🐦', '💬'];
const WORDS = ['die Stunde', 'über', 'Straße', 'la cuchara', 'H2O', 'Topic alpha', 'Ottawa', 'kaufen', 'ça va', '東京'];

export interface RandomStateOptions {
  now?: number;
  /** Most decks (at least 1 deck is always made). Default 4. */
  maxDecks?: number;
  /** Most cards in the whole state. Default 40. */
  maxCards?: number;
}

/**
 * A random but VALID v2 document: decks (some paused), cards in every
 * lifecycle state (some favorite, flagged, suspended or buried), a review log
 * whose `prev` snapshots fit the cards, sessions, and sometimes an in-flight
 * marker. Ids depend only on the generator, so the same seed gives a
 * deep-equal state.
 */
export function randomState(rnd: Random, options: RandomStateOptions = {}): StateV2 {
  const now = options.now ?? FIXED_NOW;
  const deckCount = rnd.int(1, Math.max(1, options.maxDecks ?? 4));
  const decks: Deck[] = [];
  for (let i = 0; i < deckCount; i++) {
    const deck = makeDeck({
      id: `deck-${i + 1}`,
      name: `${rnd.pick(DECK_NAMES)} ${i + 1}`,
      icon: rnd.pick(DECK_ICONS),
      active: rnd.bool(0.8),
      createdAt: now - rnd.int(1, 120) * DAY,
    });
    if (rnd.bool(0.3)) deck.desc = 'A deck made by randomState';
    decks.push(deck);
  }

  const lifecycles: Lifecycle[] = ['new', 'learning', 'review', 'mastered'];
  const cardCount = rnd.int(0, Math.max(0, options.maxCards ?? 40));
  const cards: Card[] = [];
  for (let i = 0; i < cardCount; i++) {
    const kind = rnd.pick(lifecycles);
    const card = cardInState(
      kind,
      {
        id: `card-${i + 1}`,
        deckId: rnd.pick(decks).id,
        front: `${rnd.pick(WORDS)} ${i + 1}`,
        back: `meaning ${i + 1}`,
        fav: rnd.bool(0.15),
        flagged: rnd.bool(0.1),
        suspended: rnd.bool(0.05),
        buriedUntil: rnd.bool(0.05) ? now + rnd.int(1, 20) * HOUR : null,
        createdAt: now - rnd.int(1, 90) * DAY + i,
      },
      now,
    );
    if (kind !== 'new') {
      // Some cards are due now, some later; never in the far past.
      card.due = rnd.bool(0.5) ? now - rnd.int(0, 3 * 24) * HOUR : card.due + rnd.int(0, 5) * DAY;
      card.lapses = rnd.int(0, Math.min(3, card.reps));
      if (kind !== 'learning') card.ease = 1.3 + rnd.int(0, 170) / 100;
    }
    if (rnd.bool(0.3)) card.example = `Example sentence ${i + 1}.`;
    if (rnd.bool(0.2)) card.notes = `Note ${i + 1}`;
    if (rnd.bool(0.3)) card.tags = rnd.sample(['a1', 'verb', 'German::Verbs::B1', 'core'], rnd.int(1, 2));
    cards.push(card);
  }

  // Review log: one entry per rating of a studied card, oldest first.
  const studied = cards.filter((c) => c.reps > 0);
  const reviewLog: ReviewLogEntry[] = rnd
    .sample(studied, rnd.int(0, studied.length))
    .map((card, i) =>
      makeReviewLogEntry(
        card,
        rnd.pick(RATINGS),
        {
          id: `rl-${i + 1}`,
          atMs: card.lastReviewedAt ?? now,
          prev: {
            ease: card.ease,
            intervalDays: 0,
            stepIndex: card.reps > 1 ? 0 : null,
            reps: card.reps - 1,
            lapses: card.lapses,
            due: (card.lastReviewedAt ?? now) - MIN,
            lastReviewedAt: card.reps > 1 ? (card.lastReviewedAt ?? now) - DAY : null,
          },
          wasNew: card.reps === 1,
        },
      ),
    )
    .sort((a, b) => a.atMs - b.atMs);

  const sessions: SessionRecord[] = [];
  const sessionCount = rnd.int(0, 5);
  for (let i = 0; i < sessionCount; i++) {
    const atMs = now - (sessionCount - i) * DAY + rnd.int(0, 12) * HOUR;
    const counts = { again: rnd.int(0, 3), hard: rnd.int(0, 3), good: rnd.int(1, 8), easy: rnd.int(0, 3) };
    sessions.push(
      makeSessionRecord({
        id: `s-${i + 1}`,
        atMs,
        kind: rnd.pick(SESSION_KINDS),
        counts,
        bestRun: rnd.int(1, counts.good + counts.easy),
        xp: rnd.int(5, 60),
      }),
    );
  }

  const streak = sessions.length > 0 ? rnd.int(1, 12) : 0;
  const person = makePerson(
    {
      xp: sessions.reduce((sum, s) => sum + s.xp, 0),
      streak,
      bestStreak: streak + rnd.int(0, 5),
      freezes: rnd.int(0, 2),
      lastStudyDay: sessions.length > 0 ? sessions[sessions.length - 1].dayKey : '',
      dayDone: { dayKey: dayKeyOf(now), reviews: rnd.int(0, 10), neww: rnd.int(0, 5) },
      fastAnswers: rnd.int(0, 20),
    },
    now,
  );

  const marker =
    studied.length > 0 && rnd.bool(0.25)
      ? makeMarker({ counts: { again: 0, hard: 0, good: 1, easy: 0 }, studyDay: dayKeyOf(now) })
      : null;

  return makeState(
    {
      decks,
      cards,
      reviewLog,
      sessions,
      person,
      settings: makeSettings({ sessionLimit: rnd.pick([20, 30, 50, 100]), hapticsEnabled: rnd.bool(0.7) }),
      onboarded: true,
      inProgressSession: marker,
    },
    now,
  );
}

/* --------------------------------------------------------- validity check */

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isCount = (v: unknown): boolean => isFiniteNum(v) && Number.isInteger(v) && v >= 0;
const show = (v: unknown): string => (typeof v === 'string' ? JSON.stringify(v) : String(v));

/**
 * Everything that makes `doc` NOT a valid schema-v2 document, as readable
 * lines (an empty list = valid). It takes `unknown` on purpose: migration
 * tests run it on whatever `migrate()` returns, and on the raw fixtures.
 *
 * It checks what the app relies on: the version fields, every card's texts
 * and SRS numbers (finite, ease ≥ 1.3, whole non-negative counters, stepIndex
 * null or a whole number ≥ 0), no card without a deck (no-orphan), unique ids,
 * every default setting present with the right type (+ `autoReadAloud`), and
 * the person, sessions, review log and marker shapes.
 */
export function stateProblems(doc: unknown): string[] {
  const out: string[] = [];
  if (!isObj(doc)) return ['the document is not an object'];

  // Version fields (schema v2, spec §3.1).
  const sv = doc.schemaVersion;
  const mr = doc.minReaderVersion;
  if (!isCount(sv) || (sv as number) < SCHEMA_V2) out.push(`schemaVersion is ${show(sv)}, expected a whole number ≥ 2`);
  if (!isCount(mr) || (mr as number) < SCHEMA_V2) out.push(`minReaderVersion is ${show(mr)}, expected a whole number ≥ 2`);
  if (isCount(sv) && isCount(mr) && (mr as number) > (sv as number)) out.push('minReaderVersion is above schemaVersion');

  for (const key of ['cards', 'decks', 'collections', 'sessions', 'reviewLog']) {
    if (!Array.isArray(doc[key])) out.push(`${key} is not a list`);
  }
  if (typeof doc.onboarded !== 'boolean') out.push('onboarded is not a boolean');

  // Decks.
  const deckIds = new Set<string>();
  for (const [i, d] of (Array.isArray(doc.decks) ? doc.decks : []).entries()) {
    const at = `decks[${i}]`;
    if (!isObj(d)) {
      out.push(`${at} is not an object`);
      continue;
    }
    if (typeof d.id !== 'string' || d.id === '') out.push(`${at}.id is not a text`);
    else if (deckIds.has(d.id)) out.push(`${at}.id ${show(d.id)} is used twice`);
    else deckIds.add(d.id);
    for (const key of ['name', 'icon']) if (typeof d[key] !== 'string') out.push(`${at}.${key} is not a text`);
    for (const key of ['builtin', 'active']) if (typeof d[key] !== 'boolean') out.push(`${at}.${key} is not a boolean`);
    if (!isFiniteNum(d.createdAt)) out.push(`${at}.createdAt is not a finite number`);
    if (d.desc !== undefined && typeof d.desc !== 'string') out.push(`${at}.desc is not a text`);
  }

  // Cards.
  const cardIds = new Set<string>();
  for (const [i, c] of (Array.isArray(doc.cards) ? doc.cards : []).entries()) {
    const at = `cards[${i}]`;
    if (!isObj(c)) {
      out.push(`${at} is not an object`);
      continue;
    }
    if (typeof c.id !== 'string' || c.id === '') out.push(`${at}.id is not a text`);
    else if (cardIds.has(c.id)) out.push(`${at}.id ${show(c.id)} is used twice`);
    else cardIds.add(c.id);
    if (typeof c.deckId !== 'string' || !deckIds.has(c.deckId)) out.push(`${at}.deckId ${show(c.deckId)} has no deck`);
    for (const key of ['front', 'back']) if (typeof c[key] !== 'string') out.push(`${at}.${key} is not a text`);
    for (const key of ['example', 'notes']) {
      if (c[key] !== undefined && typeof c[key] !== 'string') out.push(`${at}.${key} is not a text`);
    }
    if (c.tags !== undefined && !(Array.isArray(c.tags) && c.tags.every((t) => typeof t === 'string'))) {
      out.push(`${at}.tags is not a list of texts`);
    }
    for (const key of ['fav', 'flagged', 'suspended']) {
      if (c[key] !== undefined && typeof c[key] !== 'boolean') out.push(`${at}.${key} is not a boolean`);
    }
    if (!isFiniteNum(c.ease) || c.ease < 1.3) out.push(`${at}.ease is ${show(c.ease)}, expected a finite number ≥ 1.3`);
    if (!isFiniteNum(c.intervalDays) || c.intervalDays < 0) out.push(`${at}.intervalDays is ${show(c.intervalDays)}`);
    for (const key of ['reps', 'lapses']) if (!isCount(c[key])) out.push(`${at}.${key} is ${show(c[key])}`);
    if (c.stepIndex !== null && !isCount(c.stepIndex)) out.push(`${at}.stepIndex is ${show(c.stepIndex)}`);
    for (const key of ['due', 'createdAt']) if (!isFiniteNum(c[key])) out.push(`${at}.${key} is ${show(c[key])}`);
    if (c.lastReviewedAt !== null && !isFiniteNum(c.lastReviewedAt)) out.push(`${at}.lastReviewedAt is ${show(c.lastReviewedAt)}`);
    if (c.buriedUntil !== undefined && c.buriedUntil !== null && !isFiniteNum(c.buriedUntil)) {
      out.push(`${at}.buriedUntil is ${show(c.buriedUntil)}`);
    }
    if (c.legacy !== undefined && !isObj(c.legacy)) out.push(`${at}.legacy is not an object`);
  }

  // Collections (saved filters of today's model).
  for (const [i, col] of (Array.isArray(doc.collections) ? doc.collections : []).entries()) {
    const ok =
      isObj(col) &&
      ['id', 'name', 'icon', 'desc'].every((k) => typeof col[k] === 'string') &&
      COLLECTION_QUERIES.includes(col.query as CollectionQuery);
    if (!ok) out.push(`collections[${i}] is not a valid collection`);
  }

  // Settings: every default key, with the default's type.
  const settings = doc.settings;
  if (!isObj(settings)) out.push('settings is not an object');
  else {
    const expected: Obj = { ...DEFAULT_APP_SETTINGS, autoReadAloud: false };
    for (const key of Object.keys(expected)) {
      if (key === 'srs') continue;
      if (typeof settings[key] !== typeof expected[key]) out.push(`settings.${key} is ${show(settings[key])}`);
      else if (typeof settings[key] === 'number' && !isFiniteNum(settings[key])) out.push(`settings.${key} is not finite`);
    }
    const srs = settings.srs;
    if (!isObj(srs)) out.push('settings.srs is not an object');
    else {
      for (const key of Object.keys(DEFAULT_SRS) as (keyof SrsSettings)[]) {
        if (key === 'learningStepsMin') {
          const steps = srs[key];
          if (!Array.isArray(steps) || !steps.every((m) => isFiniteNum(m) && m > 0)) {
            out.push('settings.srs.learningStepsMin is not a list of positive minutes');
          }
        } else if (!isFiniteNum(srs[key])) out.push(`settings.srs.${key} is ${show(srs[key])}`);
      }
    }
  }

  // Person.
  const p = doc.person;
  if (!isObj(p)) out.push('person is not an object');
  else {
    for (const key of ['xp', 'streak', 'bestStreak', 'freezes', 'goalReviews', 'goalNew', 'fastAnswers']) {
      if (!isFiniteNum(p[key]) || (p[key] as number) < 0) out.push(`person.${key} is ${show(p[key])}`);
    }
    if (!(Array.isArray(p.freezeUsedDays) && p.freezeUsedDays.every((d) => typeof d === 'string'))) {
      out.push('person.freezeUsedDays is not a list of day keys');
    }
    if (p.lastStudyDay !== null && typeof p.lastStudyDay !== 'string') out.push('person.lastStudyDay is not a day key');
    const dd = p.dayDone;
    if (!(isObj(dd) && typeof dd.dayKey === 'string' && isCount(dd.reviews) && isCount(dd.neww))) {
      out.push('person.dayDone is not a valid day tally');
    }
    if (!(isObj(p.achievements) && Object.values(p.achievements).every(isFiniteNum))) {
      out.push('person.achievements is not a map of times');
    }
  }

  const validCounts = (v: unknown) => isObj(v) && RATINGS.every((r) => isCount(v[r]));

  // Sessions.
  for (const [i, s] of (Array.isArray(doc.sessions) ? doc.sessions : []).entries()) {
    const ok =
      isObj(s) &&
      typeof s.id === 'string' &&
      typeof s.dayKey === 'string' &&
      isFiniteNum(s.atMs) &&
      SESSION_KINDS.includes(s.kind as SessionKind) &&
      validCounts(s.counts) &&
      isCount(s.total) &&
      isCount(s.bestRun) &&
      isFiniteNum(s.xp);
    if (!ok) out.push(`sessions[${i}] is not a valid session record`);
  }

  // Review log.
  for (const [i, e] of (Array.isArray(doc.reviewLog) ? doc.reviewLog : []).entries()) {
    const ok =
      isObj(e) &&
      typeof e.id === 'string' &&
      typeof e.cardId === 'string' &&
      RATINGS.includes(e.rating as Rating) &&
      isFiniteNum(e.atMs) &&
      typeof e.wasNew === 'boolean' &&
      isObj(e.prev) &&
      ['ease', 'intervalDays', 'reps', 'lapses', 'due'].every((k) => isFiniteNum((e.prev as Obj)[k]));
    if (!ok) out.push(`reviewLog[${i}] is not a valid review entry`);
  }

  // In-flight session marker (M5): null, or a full snapshot.
  const m = doc.inProgressSession;
  if (m !== null) {
    const ok =
      isObj(m) &&
      SESSION_KINDS.includes(m.kind as SessionKind) &&
      typeof m.label === 'string' &&
      validCounts(m.counts) &&
      ['total', 'bestRun', 'durationSec', 'fastAnswers'].every((k) => isCount(m[k])) &&
      (m.studyDay === undefined || typeof m.studyDay === 'string');
    if (!ok) out.push('inProgressSession is not null and not a valid marker');
  }

  return out;
}

/* ----------------------------------------------------------- real fixtures */

/** The saved documents written by real old builds (see src/store/__fixtures__/README.md). */
export const STATE_FIXTURES = [
  'v0-v2.0.2',
  'v0-german-fork',
  'v0-empty-library',
  'v1-main-1333d48',
  'v1-marker-no-studyDay',
  'v1-orphan-card',
  'v1-nan-fields',
] as const;
export type StateFixtureName = (typeof STATE_FIXTURES)[number];

const STATE_FIXTURE_DIR = path.join(__dirname, '..', 'store', '__fixtures__');

/** The fixture file exactly as the old build stored it (the raw `maranki.state.v1` string). */
export function stateFixtureRaw(name: StateFixtureName): string {
  return fs.readFileSync(path.join(STATE_FIXTURE_DIR, `${name}.json`), 'utf8');
}

/** A fresh parsed copy of a fixture. Typed `unknown`-ish on purpose: old shapes are not today's types. */
export function stateFixture(name: StateFixtureName): Record<string, unknown> {
  return JSON.parse(stateFixtureRaw(name)) as Record<string, unknown>;
}

/**
 * Samples of real Anki decks (see scripts/extract-anki-fixture.py).
 * `german_vocabulary_v1` is a sample of the FIRST version of the bundled German
 * vocabulary deck (2026-06, 7 fields). `german_vocabulary_v2` samples version 2
 * (2026-10-27, + Type and Plural) and `german_vocabulary` the bundled version 4
 * (2026-10-30; since version 3: ONE example field, no MarankiExample). All three have the same notes (same guids), so a
 * test can import one version and update it to a later one (two v1 notes are
 * not in the later versions, two notes of the later versions are new). In the
 * same way `german_verbs_v1` samples the first German verbs deck and
 * `german_verbs` its current fixed version (5, 2026-10: the same 20 notes;
 * "fortsetzen" and "nachdenken" have a corrected conjugation, five hints no
 * longer name the verb, and the templates have no triple braces).
 * `german_grammar` samples grammar version 2 (none of its 5 fixed notes is in
 * the sample).
 */
export const ANKI_FIXTURES = [
  'german_vocabulary',
  'german_vocabulary_v2',
  'german_vocabulary_v1',
  'german_verbs',
  'german_verbs_v1',
  'german_grammar',
  'spanish_vocabulary',
  'algo_patterns',
] as const;
export type AnkiFixtureName = (typeof ANKI_FIXTURES)[number];

/**
 * Made-up text with the characters that the made-up fixtures do not hold
 * (scripts/make-synthetic-fixtures.py removes them). A fixture-wide loop needs
 * this line too, or a bug that loses one of them passes unseen.
 */
export const RARE_CHARS = `"quote" 'x' #0123456789 = [a] ^ _ ¿ Ö á í ð ó q HJOQUWXY ŋɡɣɾʎʝˈβθ ⊆`;

/** One `notes` row, all columns, as SQLite returns it. `flds` is joined by '\x1f'. */
export interface AnkiFixtureNote {
  id: number;
  guid: string;
  mid: number;
  mod: number;
  usn: number;
  tags: string;
  flds: string;
  sfld: string | number;
  csum: number;
  flags: number;
  data: string;
}

/** One `cards` row, all columns, as SQLite returns it. */
export interface AnkiFixtureCard {
  id: number;
  nid: number;
  did: number;
  ord: number;
  mod: number;
  usn: number;
  type: number;
  queue: number;
  due: number;
  ivl: number;
  factor: number;
  reps: number;
  lapses: number;
  left: number;
  odue: number;
  odid: number;
  flags: number;
  data: string;
}

export interface AnkiFixture {
  about: {
    source: string;
    synthetic: string;
    collectionFile: string;
    totals: { notes: number; cards: number };
    /** `kept`: notes taken from an earlier fixture first (`--keep-guids-from`). */
    sample: { notes: number; cards: number; bySubdeck: Record<string, { picked: number; of: number; kept?: number }> };
    rule: string;
    generatedBy: string;
  };
  fileName: string;
  /** The `col` row. `models` and `decks` are the RAW JSON text Anki stores. */
  col: { id: number; crt: number; mod: number; scm: number; ver: number; models: string; decks: string };
  notes: AnkiFixtureNote[];
  cards: AnkiFixtureCard[];
  /** The media manifest: "0" → "example.webp". */
  media: Record<string, string>;
}

const ANKI_FIXTURE_DIR = path.join(__dirname, '..', 'domain', '__fixtures__', 'anki');

export function ankiFixture(name: AnkiFixtureName): AnkiFixture {
  return JSON.parse(fs.readFileSync(path.join(ANKI_FIXTURE_DIR, `${name}.json`), 'utf8')) as AnkiFixture;
}
