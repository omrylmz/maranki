/**
 * Tests for the shared test support (spec W0-1):
 *   - factories.ts builds VALID schema-v2 objects with the app's real defaults,
 *     and `stateProblems` finds every kind of damage;
 *   - random.ts is seeded and deterministic;
 *   - clock.ts moves only when told to, in local days;
 *   - the fixtures are intact (byte-exact saved documents, right shapes), and
 *     no real deck text came back into them.
 */
import { describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

import { buildSeedState } from '../domain/seed';
// factories.ts builds the v2 shapes (W3-1 made the v3 note model the live one).
import {
  AppSettingsV2 as AppSettings,
  CardV2 as Card,
  DAY,
  dayKeyOf,
  DEFAULT_APP_SETTINGS_V2 as DEFAULT_APP_SETTINGS,
  DEFAULT_SRS,
  isDue,
  lifecycleState,
  MIN,
} from '../domain/types';
import { classifyStored, isValidState } from '../store/persistence';
import { addLocalDays, createClock, FIXED_NOW, localTime } from './clock';
import {
  ankiFixture,
  ANKI_FIXTURES,
  cardInState,
  DEFAULT_DECK_ID,
  Lifecycle,
  makeCard,
  makeDeck,
  makeMarker,
  makePerson,
  makeReviewLogEntry,
  makeSessionRecord,
  makeSettings,
  makeState,
  nextId,
  randomState,
  resetFactoryIds,
  STATE_FIXTURES,
  stateFixture,
  stateFixtureRaw,
  stateProblems,
} from './factories';
import { createRandom, fnv1a } from './random';

/* ------------------------------------------------------------- builders */

describe('makeCard / makeDeck — the app constructors’ defaults', () => {
  it('a card equals what DataContext.addCard creates (brand new, due now)', () => {
    const card = makeCard({ id: 'c1', front: 'die Stunde', back: 'the hour' });
    expect(card).toStrictEqual({
      id: 'c1',
      deckId: DEFAULT_DECK_ID,
      front: 'die Stunde',
      back: 'the hour',
      fav: false,
      flagged: false,
      suspended: false,
      buriedUntil: null,
      ease: DEFAULT_SRS.startingEase,
      intervalDays: 0,
      stepIndex: null,
      reps: 0,
      lapses: 0,
      due: FIXED_NOW,
      createdAt: FIXED_NOW,
      lastReviewedAt: null,
    });
  });

  it('a deck equals what DataContext.addDeck creates', () => {
    expect(makeDeck({ id: 'd1', name: 'Capitals' })).toStrictEqual({
      id: 'd1',
      name: 'Capitals',
      icon: '🗂️',
      builtin: false,
      active: true,
      createdAt: FIXED_NOW,
    });
  });

  it('keeps every optional key the test gives', () => {
    const card = makeCard({ example: 'Ex.', notes: 'N.', tags: ['a1'], fav: true, buriedUntil: FIXED_NOW + DAY });
    expect(card).toMatchObject({ example: 'Ex.', notes: 'N.', tags: ['a1'], fav: true, buriedUntil: FIXED_NOW + DAY });
    expect(makeDeck({ desc: 'About' }).desc).toBe('About');
  });

  it('never writes a key that holds undefined', () => {
    const objects = [makeCard(), makeDeck(), makeState(), makeMarker(), makeSessionRecord(), makePerson()];
    for (const object of objects) {
      expect(JSON.parse(JSON.stringify(object))).toStrictEqual(object);
    }
  });

  it('gives unique ids, and the counter can start again', () => {
    resetFactoryIds();
    const a = makeCard();
    const b = makeCard();
    expect(a.id).not.toBe(b.id);
    resetFactoryIds();
    expect(nextId('card')).toBe('card-1');
  });
});

describe('cardInState', () => {
  const kinds: Lifecycle[] = ['new', 'learning', 'review', 'mastered'];

  it.each(kinds)('a %s card has SRS fields that fit that state', (kind) => {
    const card = cardInState(kind);
    expect(lifecycleState(card)).toBe(kind);
    expect(stateProblems(makeState({ decks: [makeDeck({ id: DEFAULT_DECK_ID })], cards: [card] }))).toEqual([]);
  });

  it('is not due until the test says so', () => {
    expect(isDue(cardInState('review'), FIXED_NOW)).toBe(false);
    expect(isDue(cardInState('review', { due: FIXED_NOW - DAY }), FIXED_NOW)).toBe(true);
    expect(isDue(cardInState('learning', { due: FIXED_NOW - MIN }), FIXED_NOW)).toBe(true);
  });
});

describe('makeSettings / makePerson', () => {
  it('has every default setting plus the v2 autoReadAloud (off)', () => {
    const s = makeSettings();
    const keys = Object.keys(DEFAULT_APP_SETTINGS) as (keyof AppSettings)[];
    expect(Object.fromEntries(keys.map((k) => [k, s[k]]))).toStrictEqual(DEFAULT_APP_SETTINGS);
    expect(s.autoReadAloud).toBe(false);
  });

  it('merges srs key by key and never changes the shared defaults', () => {
    const s = makeSettings({ sessionLimit: 20, srs: { dailyNewLimit: 3 } });
    expect(s.sessionLimit).toBe(20);
    expect(s.srs).toStrictEqual({ ...DEFAULT_SRS, dailyNewLimit: 3 });
    s.srs.learningStepsMin.push(99);
    expect(DEFAULT_SRS.learningStepsMin).toEqual([1, 10]);
    expect(DEFAULT_APP_SETTINGS.srs.dailyNewLimit).toBe(10);
  });

  it('a person is the seed person (with the v2 day tally) plus overrides', () => {
    const { dayDone, ...seed } = buildSeedState(FIXED_NOW).person;
    expect(makePerson({ xp: 5 })).toStrictEqual({ ...seed, dayDone: { dayKey: dayDone.dayKey, reviews: 0, neww: 0 }, xp: 5 });
  });
});

describe('makeReviewLogEntry / makeSessionRecord / makeMarker', () => {
  it('a review entry snapshots the card before the rating', () => {
    const card = cardInState('review', { id: 'c9' });
    const entry = makeReviewLogEntry(card, 'good');
    expect(entry.cardId).toBe('c9');
    expect(entry.prev).toStrictEqual({
      ease: card.ease,
      intervalDays: card.intervalDays,
      stepIndex: card.stepIndex,
      reps: card.reps,
      lapses: card.lapses,
      due: card.due,
      lastReviewedAt: card.lastReviewedAt,
    });
    expect(entry.wasNew).toBe(false);
    expect(makeReviewLogEntry(makeCard(), 'again').wasNew).toBe(true);
  });

  it('a session record totals its counts and uses the local day of atMs', () => {
    const s = makeSessionRecord({ counts: { again: 1, hard: 0, good: 2, easy: 4 }, atMs: localTime('2026-06-09', '23:30') });
    expect(s.total).toBe(7);
    expect(s.dayKey).toBe('2026-06-09');
  });

  it('a marker carries studyDay; an older build’s marker is made by removing it', () => {
    const marker = makeMarker();
    expect(marker.studyDay).toBe(dayKeyOf(FIXED_NOW));
    expect(marker.total).toBe(3);
    const { studyDay, ...older } = marker;
    expect(studyDay).toBeDefined();
    expect('studyDay' in older).toBe(false);
  });
});

describe('makeState — a valid schema-v2 document', () => {
  it('has the v2 version fields and no problems', () => {
    const state = makeState();
    expect(state.schemaVersion).toBe(2);
    expect(state.minReaderVersion).toBe(2);
    expect(stateProblems(state)).toEqual([]);
  });

  it('is built on the real first-run seed', () => {
    const seed = buildSeedState(FIXED_NOW);
    const state = makeState();
    expect(state.collections).toStrictEqual(seed.collections);
    expect(state.person).toStrictEqual(makePerson());
    expect(state.cards).toEqual([]);
    expect(state.onboarded).toBe(false);
    expect(state.inProgressSession).toBeNull();
  });

  it('passes today’s load check (a schema-2 document loads, from 2) and survives a JSON round trip unchanged', () => {
    const deck = makeDeck({ id: 'd1' });
    const kinds: Lifecycle[] = ['new', 'learning', 'review', 'mastered'];
    const state = makeState({
      decks: [deck],
      cards: kinds.map((k) => cardInState(k, { deckId: 'd1' })),
      inProgressSession: makeMarker(),
      onboarded: true,
    });
    expect(stateProblems(state)).toEqual([]);
    expect(isValidState(state)).toBe(true);
    expect(JSON.parse(JSON.stringify(state))).toStrictEqual(state);
    // Since W3-1 the load migrates it to the v3 note model: the same cards, by id.
    const outcome = classifyStored(JSON.stringify(state));
    expect(outcome.kind).toBe('loaded');
    if (outcome.kind === 'loaded') {
      expect(outcome.from).toBe(2);
      expect(outcome.repaired).toEqual([]);
      expect(outcome.state.cards.map((c) => c.id)).toEqual(state.cards.map((c) => c.id));
    }
  });
});

/* ---------------------------------------------------------- stateProblems */

describe('stateProblems', () => {
  it('rejects something that is not a document', () => {
    expect(stateProblems(null)).toEqual(['the document is not an object']);
    expect(stateProblems([])).toEqual(['the document is not an object']);
  });

  it('a v1 document (main@1333d48) only lacks the v2 additions', () => {
    expect(stateProblems(stateFixture('v1-main-1333d48'))).toEqual([
      'schemaVersion is undefined, expected a whole number ≥ 2',
      'minReaderVersion is undefined, expected a whole number ≥ 2',
      'settings.autoReadAloud is undefined',
    ]);
  });

  it('a v0 document (v2.0.2) has the old card and settings shape', () => {
    const problems = stateProblems(stateFixture('v0-v2.0.2'));
    expect(problems).toContain('cards[0].front is not a text');
    expect(problems).toContain('settings.readAloudEnabled is undefined');
  });

  it('finds the orphan card', () => {
    const extra = newProblems('v1-orphan-card');
    expect(extra).toHaveLength(1);
    expect(extra[0]).toMatch(/\.deckId "d-deleted-deck" has no deck$/);
  });

  it('finds every broken number and text in the NaN fixture', () => {
    const extra = newProblems('v1-nan-fields');
    const expected = [
      /\.ease is null/, //            NaN saved as null (France)
      /\.due is null/, //             NaN saved as null (France)
      /\.ease is 1\.1/, //            below the 1.3 floor (Japan)
      /\.intervalDays is null/, //    Infinity saved as null (Canada)
      /\.reps is null/, //            (Canada)
      /\.lapses is null/, //          (Canada)
      /\.reps is -2/, //              negative (Kenya)
      /\.lapses is -1/, //            negative (Kenya)
      /\.stepIndex is 1\.5/, //       not a whole number (Australia)
      /\.stepIndex is -1/, //         negative (H2O)
      /\.front is not a text/, //     42 (CO2)
      /\.back is not a text/, //      null (CO2) and missing (Fe)
      /\.due is "2026-07-22"/, //     a string (CH4)
    ];
    for (const pattern of expected) {
      expect(extra.some((line) => pattern.test(line))).toBe(true);
    }
    expect(extra.filter((line) => /\.back is not a text/.test(line))).toHaveLength(2);
    expect(extra).toHaveLength(14);
  });

  it('finds duplicate ids and a broken marker', () => {
    const deck = makeDeck({ id: 'd1' });
    const state = makeState({
      decks: [deck, { ...deck }],
      cards: [makeCard({ id: 'c1', deckId: 'd1' }), makeCard({ id: 'c1', deckId: 'd1' })],
      inProgressSession: { ...makeMarker(), total: -1 },
    });
    expect(stateProblems(state)).toEqual([
      'decks[1].id "d1" is used twice',
      'cards[1].id "c1" is used twice',
      'inProgressSession is not null and not a valid marker',
    ]);
  });
});

/** Problems a derived fixture has on top of the v1 fixture it was made from. */
function newProblems(name: 'v1-orphan-card' | 'v1-nan-fields'): string[] {
  const base = new Set(stateProblems(stateFixture('v1-main-1333d48')));
  return stateProblems(stateFixture(name)).filter((line) => !base.has(line));
}

/* ------------------------------------------------------------ randomState */

describe('randomState', () => {
  const seeds = Array.from({ length: 50 }, (_, i) => i + 1);

  it('is a valid v2 document for 50 seeds', () => {
    for (const seed of seeds) {
      const problems = stateProblems(randomState(createRandom(seed)));
      if (problems.length > 0) throw new Error(`seed ${seed}: ${problems.join('; ')}`);
    }
  });

  it('the same seed gives a deep-equal state; another seed a different one', () => {
    expect(randomState(createRandom(7))).toStrictEqual(randomState(createRandom(7)));
    expect(randomState(createRandom(7))).not.toEqual(randomState(createRandom(8)));
  });

  it('does not depend on other factory calls (ids come from the generator)', () => {
    const first = randomState(createRandom(11));
    makeCard();
    makeDeck();
    expect(randomState(createRandom(11))).toStrictEqual(first);
  });

  it('survives a JSON round trip unchanged (no undefined, no NaN)', () => {
    for (const seed of seeds) {
      const state = randomState(createRandom(seed));
      expect(JSON.parse(JSON.stringify(state))).toStrictEqual(state);
    }
  });

  it('over many seeds, covers every lifecycle, flag, paused decks and markers', () => {
    const states = seeds.map((seed) => randomState(createRandom(seed)));
    const cards: Card[] = states.flatMap((s) => s.cards);
    expect(new Set(cards.map(lifecycleState))).toEqual(new Set(['new', 'learning', 'review', 'mastered']));
    expect(cards.some((c) => c.fav)).toBe(true);
    expect(cards.some((c) => c.flagged)).toBe(true);
    expect(cards.some((c) => c.suspended)).toBe(true);
    expect(cards.some((c) => c.buriedUntil != null)).toBe(true);
    expect(cards.some((c) => isDue(c, FIXED_NOW))).toBe(true);
    expect(states.some((s) => s.decks.some((d) => !d.active))).toBe(true);
    expect(states.some((s) => s.inProgressSession !== null)).toBe(true);
    expect(states.some((s) => s.reviewLog.length > 0 && s.sessions.length > 0)).toBe(true);
  });

  it('respects the size limits', () => {
    for (const seed of seeds) {
      const s = randomState(createRandom(seed), { maxDecks: 2, maxCards: 5 });
      expect(s.decks.length).toBeLessThanOrEqual(2);
      expect(s.cards.length).toBeLessThanOrEqual(5);
    }
  });
});

/* ------------------------------------------------------------------ random */

describe('createRandom — seeded and deterministic', () => {
  it('matches the published mulberry32 output for seed 1', () => {
    expect(createRandom(1).next()).toBe(0.6270739405881613);
  });

  it('gives the same sequence for the same seed, every time', () => {
    const draw = (seed: number | string) => {
      const rnd = createRandom(seed);
      return Array.from({ length: 5 }, () => rnd.next());
    };
    expect(draw(42)).toEqual([
      0.6011037519201636, 0.44829055899754167, 0.8524657934904099, 0.6697340414393693, expect.any(Number),
    ]);
    expect(draw(42)).toEqual(draw(42));
    expect(draw(42)).not.toEqual(draw(43));
    expect(draw('cards')).toEqual(draw(fnv1a('cards')));
  });

  it('fnv1a matches the standard test vectors', () => {
    expect(fnv1a('')).toBe(0x811c9dc5);
    expect(fnv1a('a')).toBe(0xe40c292c);
    expect(fnv1a('foobar')).toBe(0xbf9cf968);
  });

  it('int stays inside its bounds, both ends included', () => {
    const rnd = createRandom(3);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) {
      const n = rnd.int(-2, 2);
      expect(Number.isInteger(n) && n >= -2 && n <= 2).toBe(true);
      seen.add(n);
    }
    expect([...seen].sort()).toEqual([-1, -2, 0, 1, 2]);
    expect(() => rnd.int(5, 1)).toThrow();
    expect(() => rnd.int(0.5, 1)).toThrow();
  });

  it('bool, pick and sample', () => {
    const rnd = createRandom(4);
    expect(rnd.bool(0)).toBe(false);
    expect(rnd.bool(1)).toBe(true);
    expect(['a', 'b']).toContain(rnd.pick(['a', 'b']));
    expect(() => rnd.pick([])).toThrow();
    const picked = rnd.sample([1, 2, 3, 4, 5], 3);
    expect(new Set(picked).size).toBe(3);
    expect(() => rnd.sample([1], 2)).toThrow();
  });

  it('shuffle returns a new permutation and leaves the input alone', () => {
    const input = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8]);
    const out = createRandom(5).shuffle(input);
    expect([...out].sort((a, b) => a - b)).toEqual([...input]);
    expect(out).not.toBe(input);
    expect(createRandom(5).shuffle(input)).toEqual(out);
  });

  it('a fork does not change when the parent draws more', () => {
    const a = createRandom(9);
    const b = createRandom(9);
    b.next();
    b.next();
    expect(a.fork('cards').next()).toBe(b.fork('cards').next());
    expect(a.fork('cards').next()).not.toBe(a.fork('decks').next());
  });

  it('ids are deterministic', () => {
    expect(createRandom(12).id('n')).toBe(createRandom(12).id('n'));
    expect(createRandom(12).id('n')).toMatch(/^n-[0-9a-z]+$/);
  });

  it('rejects a seed that is not a finite number', () => {
    expect(() => createRandom(Number.NaN)).toThrow();
  });
});

/* ------------------------------------------------------------------- clock */

describe('test clock', () => {
  it('FIXED_NOW is a Wednesday, 09:00 local time', () => {
    const d = new Date(FIXED_NOW);
    expect(dayKeyOf(FIXED_NOW)).toBe('2026-06-10');
    expect([d.getDay(), d.getHours(), d.getMinutes()]).toEqual([3, 9, 0]);
  });

  it('localTime builds local wall-clock moments and refuses typos', () => {
    const t = localTime('2026-03-14', '23:58');
    expect(dayKeyOf(t)).toBe('2026-03-14');
    expect([new Date(t).getHours(), new Date(t).getMinutes()]).toEqual([23, 58]);
    expect(() => localTime('2026-3-14')).toThrow();
    expect(() => localTime('2026-03-14', '9:00')).toThrow();
  });

  it('only moves when the test moves it; 23:58 + 4 min is the next day', () => {
    const clock = createClock(localTime('2026-06-10', '23:58'));
    expect(clock.now()).toBe(clock.now());
    expect(clock.dayKey()).toBe('2026-06-10');
    clock.advance(4 * MIN);
    expect(clock.dayKey()).toBe('2026-06-11');
    expect(() => clock.advance(-1)).toThrow();
  });

  it('now can be passed around as a plain function', () => {
    const clock = createClock();
    const { now } = clock;
    clock.advance(1000);
    expect(now()).toBe(FIXED_NOW + 1000);
  });

  it('nextDay keeps the wall-clock time, or sets a new one', () => {
    const clock = createClock(localTime('2026-06-10', '21:15'));
    clock.nextDay();
    expect(clock.now()).toBe(localTime('2026-06-11', '21:15'));
    clock.nextDay('07:30');
    expect(clock.now()).toBe(localTime('2026-06-12', '07:30'));
    clock.set(FIXED_NOW);
    expect(clock.now()).toBe(FIXED_NOW);
    expect(addLocalDays(localTime('2026-06-30', '12:00'), 1)).toBe(localTime('2026-07-01', '12:00'));
  });
});

/* ---------------------------------------------------------------- fixtures */

describe('state fixtures (src/store/__fixtures__)', () => {
  it.each(STATE_FIXTURES)('%s is exactly a JSON.stringify output (what serialize() wrote)', (name) => {
    const raw = stateFixtureRaw(name);
    expect(raw).toBe(JSON.stringify(JSON.parse(raw)));
    expect(raw.length).toBeLessThan(150 * 1024);
  });

  it('v0-v2.0.2: old card + settings shape, a killed session without studyDay', () => {
    const doc = stateFixture('v0-v2.0.2') as any;
    expect(doc.cards.length).toBeGreaterThan(0);
    expect(doc.cards.length).toBeLessThanOrEqual(80);
    expect(doc.cards.every((c: any) => typeof c.word === 'string' && c.front === undefined)).toBe(true);
    expect(doc.cards.find((c: any) => c.word === 'die Stunde')).toMatchObject({ ipa: '/ˈʃtʊndə/', exTr: 'We meet in an hour.' });
    expect(doc.decks.every((d: any) => typeof d.flag === 'string' && d.icon === undefined)).toBe(true);
    expect(doc.settings).toMatchObject({ ttsEnabled: true, autoPlayAudio: true, pronunciationPrompt: true, reminderEnabled: true });
    expect(doc.settings.readAloudEnabled).toBeUndefined();
    expect(doc.inProgressSession).toMatchObject({ total: 3 });
    expect(doc.inProgressSession.studyDay).toBeUndefined();
    expect(doc.sessions).toHaveLength(1);
    expect(doc.reviewLog).toHaveLength(6);
    expect(doc.cards.filter((c: any) => c.fav)).toHaveLength(2);
    expect(doc.cards.filter((c: any) => c.flagged)).toHaveLength(1);
  });

  it('v0-german-fork: v0 shape, linguistic fields, a marker WITH studyDay', () => {
    const doc = stateFixture('v0-german-fork') as any;
    expect(doc.cards.every((c: any) => typeof c.word === 'string' && typeof c.lang === 'string')).toBe(true);
    expect(doc.cards.some((c: any) => c.level != null && c.type != null)).toBe(true);
    expect(doc.cards.length).toBeLessThanOrEqual(80);
    expect(doc.inProgressSession.studyDay).toBe('2026-07-15');
  });

  it('v0-empty-library: no cards and no decks; only the settings tell it is v0', () => {
    const doc = stateFixture('v0-empty-library') as any;
    expect(doc.cards).toEqual([]);
    expect(doc.decks).toEqual([]);
    expect(typeof doc.settings.ttsEnabled).toBe('boolean');
    expect(doc.settings.readAloudEnabled).toBeUndefined();
    expect(doc.sessions.length).toBeGreaterThan(0);
  });

  it('v1-main-1333d48: front/back cards, readAloudEnabled, a marker with studyDay', () => {
    const doc = stateFixture('v1-main-1333d48') as any;
    expect(doc.cards.every((c: any) => typeof c.front === 'string' && c.word === undefined)).toBe(true);
    expect(doc.decks.every((d: any) => typeof d.icon === 'string' && d.flag === undefined)).toBe(true);
    expect(typeof doc.settings.readAloudEnabled).toBe('boolean');
    expect(doc.inProgressSession.studyDay).toBe('2026-07-21');
  });

  it('the derived v1 fixtures differ from v1-main in exactly one place', () => {
    const main = stateFixture('v1-main-1333d48') as any;
    const noDay = stateFixture('v1-marker-no-studyDay') as any;
    expect(noDay.inProgressSession.studyDay).toBeUndefined();
    expect({ ...noDay, inProgressSession: main.inProgressSession }).toStrictEqual(main);

    const orphan = stateFixture('v1-orphan-card') as any;
    const changed = orphan.cards.filter((c: any, i: number) => c.deckId !== main.cards[i].deckId);
    expect(changed).toHaveLength(1);
    expect(orphan.decks).toStrictEqual(main.decks);
  });
});

describe('Anki fixtures (src/domain/__fixtures__/anki)', () => {
  it.each(ANKI_FIXTURES)('%s: 20 notes, their cards, models with templates, media manifest', (name) => {
    const fx = ankiFixture(name);
    expect(fx.notes).toHaveLength(20);
    const noteIds = new Set(fx.notes.map((n) => n.id));
    expect(fx.cards.every((c) => noteIds.has(c.nid))).toBe(true);
    expect(fx.notes.every((n) => fx.cards.some((c) => c.nid === n.id))).toBe(true);
    expect(fx.cards.every((c) => [c.type, c.queue, c.due, c.ivl, c.factor, c.reps, c.lapses, c.flags].every(Number.isFinite))).toBe(true);
    expect(fx.notes.every((n) => typeof n.guid === 'string' && n.guid.length > 0)).toBe(true);
    expect(Number.isFinite(fx.col.crt)).toBe(true);

    const models = JSON.parse(fx.col.models) as Record<string, any>;
    for (const n of fx.notes) {
      const model = models[String(n.mid)];
      expect(model).toBeDefined();
      expect(n.flds.split('\x1f')).toHaveLength(model.flds.length);
      expect(typeof model.sortf).toBe('number');
      expect(model.tmpls.every((t: any) => typeof t.qfmt === 'string' && typeof t.afmt === 'string')).toBe(true);
    }
    const decks = JSON.parse(fx.col.decks) as Record<string, { name: string }>;
    expect(fx.cards.every((c) => decks[String(c.odid || c.did)] !== undefined)).toBe(true);
    expect(typeof fx.media).toBe('object');
  });

  it('every subdeck of a deck is in its sample', () => {
    for (const name of ANKI_FIXTURES) {
      const fx = ankiFixture(name);
      const decks = JSON.parse(fx.col.decks) as Record<string, { name: string }>;
      const used = new Set(fx.cards.map((c) => decks[String(c.did)].name));
      expect([...used].sort()).toEqual(Object.keys(fx.about.sample.bySubdeck).sort());
    }
  });

  it('Algo_Patterns keeps its image references and the media manifest', () => {
    const fx = ankiFixture('algo_patterns');
    expect(fx.notes.some((n) => /<img src="/.test(n.flds))).toBe(true);
    expect(Object.values(fx.media)).toContain('picture-7.webp');
  });
});

/*
 * This repo is public and the Anki decks are private. Every fixture is made
 * up by scripts/make-synthetic-fixtures.py. These tests fail when a whole real
 * file comes back, for example after a regeneration without that script. Real
 * text is full of common words, and the made-up text has none of them. They
 * cannot see ONE real note pasted by hand (RELEASING.md "Test fixtures").
 */
describe('real fixture text', () => {
  const COMMON = new Set(
    (
      'nicht haben wird oder wenn werden auch nach über kann sind durch ' +
      'have each array time into about using after before number people other their ' +
      'para pero como este tiene hacer'
    ).split(' '),
  );
  const hits = (text: string) => (text.toLowerCase().match(/\p{L}+/gu) ?? []).filter((word) => COMMON.has(word));

  it.each(ANKI_FIXTURES)('%s is marked as made up, and holds none of the common words', (name) => {
    const fx = ankiFixture(name);
    expect(fx.about.synthetic).toContain('Made-up text');
    expect(fx.notes.flatMap((n) => hits(n.flds))).toEqual([]);
  });

  it('the coding deck keeps its made-up name, and its topic tags are neutral', () => {
    const fx = ankiFixture('algo_patterns');
    expect(fx.col.decks).toContain('Algo Deck');
    const tags = fx.notes.flatMap((n) => n.tags.trim().split(' '));
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) expect(tag).toMatch(/^Algo::[A-Za-z_]+::Topic_\d\d$/);
    expect(JSON.stringify(stateFixture('v1-main-1333d48'))).toContain('Algo Deck');
  });

  // The tests here read only known names. This one finds a file with a NEW name.
  // Every kind of file counts, not only .json. .DS_Store is the Mac's own file.
  it('the fixture folders hold only known files', () => {
    const files = (dir: string) => fs.readdirSync(path.join(__dirname, '..', dir)).filter((f) => f !== '.DS_Store').sort();
    expect(files('domain/__fixtures__')).toEqual(['anki']);
    expect(files('domain/__fixtures__/anki')).toEqual(ANKI_FIXTURES.map((name) => `${name}.json`).sort());
    expect(files('store/__fixtures__')).toEqual(
      ['README.md', 'v0-v2.0.2-device.json', ...STATE_FIXTURES.map((name) => `${name}.json`)].sort(),
    );
  });

  // Not v0-v2.0.2: it holds the public curated decks of that old release.
  it.each(STATE_FIXTURES.filter((name) => name !== 'v0-v2.0.2' && name !== 'v0-empty-library'))(
    '%s: the cards outside a built-in deck hold none of the common words',
    (name) => {
      const state = stateFixture(name) as {
        decks: { id: string; builtin?: boolean }[];
        cards: (Record<string, unknown> & { deckId: string })[];
      };
      const builtin = new Set(state.decks.filter((d) => d.builtin).map((d) => d.id));
      const text = state.cards
        .filter((card) => !builtin.has(card.deckId))
        .flatMap((card) => ['word', 'base', 'tr', 'ipa', 'ex', 'exTr', 'front', 'back', 'example', 'notes'].map((key) => card[key]))
        .filter((value): value is string => typeof value === 'string');
      expect(text.flatMap(hits)).toEqual([]);
    },
  );
});
