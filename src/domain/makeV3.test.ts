/**
 * The shared v3 constructors (W0-2). The load-bearing properties:
 *   - every optional key a caller passes survives (a constructor that drops
 *     `knownAt` or `legacy` would silently lose data on import or migration),
 *   - a new card's SRS defaults equal today's addCard, so the scheduler sees a
 *     card made by the v3 code exactly like one made by the v2 code,
 *   - an explicit `undefined` never replaces a default (no NaN due dates),
 *   - a card id is never made from (note, ord): the caller always gives it, so
 *     a card created again after a delete never takes the deleted card's id
 *     (and its review history).
 *
 * The `OptionalKeys` objects below are typed with `Required<…>`, so adding a
 * new optional key to Card, Deck or DeckOptions breaks this test at compile
 * time until the key is listed here — the "survives" check cannot go stale.
 *
 * The last two blocks check, at compile time (`npm run typecheck`), the store
 * contracts later waves code against: the v3 `Actions` (src/store/actions.ts)
 * accepts the v3 shapes these constructors build (the M6, M5 and practice
 * flows must type-check), and `useData()` exposes every `PersistError`.
 */
import { describe, expect, it } from '@jest/globals';

import type { Actions, PersistError } from '../store/actions';
import type { useData } from '../store/DataContext';
import { DEFAULT_SRS } from './types';
import {
  DEFAULT_DECK_ICON,
  DEFAULT_DECK_OPTIONS,
  makeCard,
  type MakeCardOpts,
  makeDeck,
  makeNote,
  nextDeckOrder,
} from './makeV3';
import type {
  Card,
  Deck,
  DeckOptions,
  InProgressSession,
  LegacyCardV0,
  Note,
  RevlogRow,
  SessionRecord,
} from './model';

const NOW = 1_700_000_000_000;

/** The keys of T that are optional (`k?: …`): `{ k?: X }` does not extend `{ k: X }`. */
type OptionalKeys<T> = {
  [K in keyof T]-?: Pick<T, K> extends Required<Pick<T, K>> ? never : K;
}[keyof T];

const LEGACY: LegacyCardV0 = {
  word: 'die Stunde',
  article: 'die',
  base: 'Stunde',
  tr: 'the hour',
  ipa: '/ˈʃtʊndə/',
  ex: 'Eine Stunde später.',
  exTr: 'One hour later.',
  level: 'A1',
  type: 'noun',
  lang: 'de',
};

function note(o: Partial<Note> = {}): Note {
  return makeNote({ id: 'n1', typeId: 'nt-basic', fields: ['front', 'back', '', ''], ...o }, NOW);
}

/* ------------------------------------------------------------------ makeNote */

describe('makeNote', () => {
  it('fills the defaults: no tags, root section, manual guid, createdAt order', () => {
    expect(note()).toEqual({
      id: 'n1',
      typeId: 'nt-basic',
      fields: ['front', 'back', '', ''],
      tags: [],
      section: '',
      guid: 'm-n1',
      order: NOW,
      source: { kind: 'manual' },
      createdAt: NOW,
      updatedAt: NOW,
    });
  });

  it('keeps every key the caller passes, including the nested optional source keys', () => {
    const full: Note = {
      id: 'n2',
      typeId: 'nt-legacy-de',
      fields: ['die Stunde', 'the hour'],
      tags: ['Algo::Core', 'marked'],
      section: 'Verbs::B1',
      guid: 'f6!Ab#9x',
      order: 42,
      source: { kind: 'apkg', ref: 'German.apkg', ankiNoteId: '1612345678901' },
      createdAt: 5,
      updatedAt: 6,
    };
    expect(makeNote(full, NOW)).toEqual(full);
  });

  it('copies the arrays, so the caller can never change the stored note', () => {
    const fields = ['a', 'b'];
    const tags = ['t'];
    const source = { kind: 'csv' as const, ref: 'words.csv' };
    const n = makeNote({ id: 'n3', typeId: 'nt-basic', fields, tags, source }, NOW);
    expect(n.fields).not.toBe(fields);
    expect(n.tags).not.toBe(tags);
    expect(n.source).not.toBe(source);
    fields.push('c');
    tags.push('u');
    expect(n.fields).toEqual(['a', 'b']);
    expect(n.tags).toEqual(['t']);
  });

  it('an explicit undefined keeps the default', () => {
    const n = makeNote(
      { id: 'n4', typeId: 'nt-basic', fields: [], section: undefined, guid: undefined, order: undefined },
      NOW,
    );
    expect(n.section).toBe('');
    expect(n.guid).toBe('m-n4');
    expect(n.order).toBe(NOW);
  });

  it('the default order is the given createdAt, not now', () => {
    expect(makeNote({ id: 'n5', typeId: 'nt-basic', fields: [], createdAt: 5 }, NOW).order).toBe(5);
    // An explicit undefined order also falls back to the given createdAt.
    expect(makeNote({ id: 'n6', typeId: 'nt-basic', fields: [], createdAt: 5, order: undefined }, NOW).order).toBe(5);
    // A given order always wins.
    expect(makeNote({ id: 'n7', typeId: 'nt-basic', fields: [], createdAt: 5, order: 9 }, NOW).order).toBe(9);
  });

  it('notes made with only createdAt (a migration step) keep their creation order in the new-card feed', () => {
    // §3.5: a migrated note has order = card.createdAt. A caller that passes
    // only createdAt must not get the same order (= now) on every note.
    const createdAts = [300, 100, 200];
    const cards = createdAts.map((createdAt, i) =>
      makeCard(makeNote({ id: `m${i}`, typeId: 'nt-basic', fields: [], createdAt }, NOW), 0, 'd1', DEFAULT_SRS, NOW, {
        id: `c${i}`,
      }),
    );
    expect(cards.map((c) => c.newPos)).toEqual([300, 100, 200]);
    const feed = [...cards].sort((a, b) => a.newPos - b.newPos).map((c) => c.noteId);
    expect(feed).toEqual(['m1', 'm2', 'm0']);
  });
});

/* ------------------------------------------------------------------ makeCard */

describe('makeCard', () => {
  it("SRS defaults equal today's addCard (ease = startingEase, interval 0, stepIndex null, reps 0, lapses 0, due = now)", () => {
    const srs = { ...DEFAULT_SRS, startingEase: 2.3 }; // not the 2.5 default: proves it is read
    const c = makeCard(note(), 0, 'd1', srs, NOW, { id: 'c1' });
    // These are exactly the values DataContext.addCard writes today.
    expect(c).toMatchObject({
      ease: 2.3,
      intervalDays: 0,
      stepIndex: null,
      reps: 0,
      lapses: 0,
      due: NOW,
      createdAt: NOW,
      lastReviewedAt: null,
      fav: false,
      flagged: false,
      suspended: false,
      buriedUntil: null,
    });
  });

  it('sets the identity from the arguments and the feed from the note', () => {
    const n = note({ id: 'n9', order: 17 });
    const c = makeCard(n, 1, 'd1', DEFAULT_SRS, NOW, { id: 'c9' });
    expect(c.id).toBe('c9');
    expect(c.noteId).toBe('n9');
    expect(c.deckId).toBe('d1');
    expect(c.ord).toBe(1);
    // Siblings share the note's feed position.
    expect(c.newPos).toBe(17);
    expect(makeCard(n, 0, 'd1', DEFAULT_SRS, NOW, { id: 'c10' }).newPos).toBe(17);
    // Absent newState = 'queued' (a New card); nothing optional is invented.
    expect('newState' in c).toBe(false);
    expect('knownAt' in c).toBe(false);
    expect('legacy' in c).toBe(false);
  });

  it('keeps newState and newPos from the options', () => {
    const c = makeCard(note(), 0, 'd1', DEFAULT_SRS, NOW, { id: 'c1', newState: 'notStarted', newPos: 3 });
    expect(c.newState).toBe('notStarted');
    expect(c.newPos).toBe(3);
    const q = makeCard(note(), 0, 'd1', DEFAULT_SRS, NOW, { id: 'c2', newState: 'queued' });
    expect(q.newState).toBe('queued');
  });

  it('keeps every optional Card key', () => {
    const optional: Required<Pick<Card, OptionalKeys<Card>>> = {
      newState: 'notStarted',
      knownAt: 111,
      knownCheckedAt: 222,
      fav: true,
      flagged: true,
      flagColor: 4,
      suspended: true,
      buriedUntil: 333,
      legacy: LEGACY,
    };
    const c = makeCard(note(), 0, 'd1', DEFAULT_SRS, NOW, { id: 'c1', ...optional });
    expect(c).toMatchObject(optional);
    expect(c.legacy).toEqual(LEGACY);
  });

  it('keeps an existing id and imported SRS progress (migration and Anki import)', () => {
    const srsState = {
      id: 'c-legacy-7',
      ease: 2.1,
      intervalDays: 30,
      stepIndex: null,
      reps: 9,
      lapses: 2,
      due: NOW + 5,
      createdAt: 7,
      lastReviewedAt: NOW - 5,
    };
    const c = makeCard(note(), 0, 'd1', DEFAULT_SRS, NOW, srsState);
    expect(c).toMatchObject(srsState);
  });

  it('an explicit undefined never replaces a default (no NaN in SRS math)', () => {
    const c = makeCard(note(), 0, 'd1', DEFAULT_SRS, NOW, {
      id: 'c1',
      ease: undefined,
      due: undefined,
      newPos: undefined,
      reps: undefined,
    });
    expect(c.id).toBe('c1');
    expect(c.ease).toBe(DEFAULT_SRS.startingEase);
    expect(c.due).toBe(NOW);
    expect(c.newPos).toBe(NOW);
    expect(c.reps).toBe(0);
  });

  it('the id is required: there is no default id made from (note, ord)', () => {
    // Compile-time checks (`npm run typecheck`): `id` is a required key of
    // the options, and the options argument itself is required.
    type IdIsOptional = 'id' extends OptionalKeys<MakeCardOpts> ? true : false;
    type OptsAreOptional = undefined extends Parameters<typeof makeCard>[5] ? true : false;
    const idIsOptional: IdIsOptional = false;
    const optsAreOptional: OptsAreOptional = false;
    expect(idIsOptional).toBe(false);
    expect(optsAreOptional).toBe(false);
  });

  it('a direction created again after a delete gets a new id, not the deleted card history', () => {
    // A cloze note: card c2 (ord 1) is studied, then the cloze is removed
    // (cloze sync deletes the card) and added again (a new card for ord 1).
    // revlog rows of a deleted card are never deleted (spec §3.8).
    const n = note({ id: 'n1' });
    const deleted = makeCard(n, 1, 'd1', DEFAULT_SRS, NOW, { id: 'c-old', reps: 7, lapses: 1 });
    const revlog: Pick<RevlogRow, 'seq' | 'cardId'>[] = [
      { seq: 1, cardId: deleted.id },
      { seq: 2, cardId: deleted.id },
    ];
    const again = makeCard(n, 1, 'd1', DEFAULT_SRS, NOW + 1, { id: 'c-new' });
    // Same note, same direction — but its own id, so its own (empty) history.
    expect(again.noteId).toBe(deleted.noteId);
    expect(again.ord).toBe(deleted.ord);
    expect(again.id).toBe('c-new');
    expect(again.id).not.toBe(deleted.id);
    expect(revlog.filter((r) => r.cardId === again.id)).toEqual([]);
    // And it is a brand-new card: no progress is inherited.
    expect(again).toMatchObject({ reps: 0, lapses: 0, intervalDays: 0 });
  });
});

/* ------------------------------------------------------------------ makeDeck */

describe('makeDeck', () => {
  it('fills the defaults: emoji, active, order 0, manual, Basic, default options', () => {
    expect(makeDeck({ id: 'd1', name: 'Spanish verbs' }, NOW)).toEqual({
      id: 'd1',
      name: 'Spanish verbs',
      icon: DEFAULT_DECK_ICON,
      active: true,
      order: 0,
      source: 'manual',
      defaultTypeId: 'nt-basic',
      options: { newPerDay: null, newOrder: 'source', newArrival: 'queued', knownChecks: true },
      createdAt: NOW,
    });
  });

  it('keeps every optional Deck key and every optional DeckOptions key', () => {
    const optional: Required<Pick<Deck, OptionalKeys<Deck>>> = {
      desc: 'All the verbs',
      sourceKey: 'pack:german:verbs',
      language: 'de-DE',
      meaningLanguage: 'en-US',
      genderColors: false,
      defaultTypeId: 'nt-basic-reverse',
      defaultTypeChosen: true,
      builtin: true,
      legacy: { flag: '🇩🇪', lang: 'de', level: 'B1' },
    };
    const optionalOptions: Required<Pick<DeckOptions, OptionalKeys<DeckOptions>>> = {
      directions: { 'nt-basic-reverse': [0] },
    };
    const d = makeDeck(
      { id: 'd2', name: 'German', ...optional, options: optionalOptions },
      NOW,
    );
    expect(d).toMatchObject(optional);
    expect(d.options.directions).toEqual({ 'nt-basic-reverse': [0] });
  });

  it('keeps every required key the caller overrides', () => {
    const full: Deck = {
      id: 'd3',
      name: 'Imported',
      icon: '🇪🇸',
      active: false,
      order: 7,
      source: 'apkg',
      options: { newPerDay: 5, newOrder: 'random', newArrival: 'notStarted', knownChecks: false },
      createdAt: 9,
    };
    expect(makeDeck(full, NOW)).toEqual({ ...full, defaultTypeId: 'nt-basic' });
  });

  it('merges partial options over the defaults, and never shares the defaults object', () => {
    const d = makeDeck({ id: 'd4', name: 'X', options: { newPerDay: 5, newOrder: undefined } }, NOW);
    expect(d.options).toEqual({ ...DEFAULT_DECK_OPTIONS, newPerDay: 5 });
    expect(d.options).not.toBe(DEFAULT_DECK_OPTIONS);
    expect(makeDeck({ id: 'd5', name: 'Y' }, NOW).options).not.toBe(DEFAULT_DECK_OPTIONS);
  });

  it('an explicit undefined keeps the default', () => {
    const d = makeDeck({ id: 'd6', name: 'Z', icon: undefined, active: undefined, order: undefined }, NOW);
    expect(d.icon).toBe(DEFAULT_DECK_ICON);
    expect(d.active).toBe(true);
    expect(d.order).toBe(0);
  });
});

describe('nextDeckOrder', () => {
  it('puts a new deck after every existing deck', () => {
    expect(nextDeckOrder([])).toBe(0);
    expect(nextDeckOrder([{ order: 0 }])).toBe(1);
    expect(nextDeckOrder([{ order: 3 }, { order: 0 }, { order: 1 }])).toBe(4);
  });

  it('ignores a broken (non-finite) order', () => {
    expect(nextDeckOrder([{ order: Number.NaN }, { order: 2 }])).toBe(3);
  });
});

/* ------------------------------------------ the v3 Actions contract */

/*
 * W3-2 implements `Actions` in parallel with W3-1 (which makes types.ts v3).
 * So the contract must use the v3 shapes on its own. Each `const x: T = …`
 * below is the real check: `tsc` fails if `Actions` mixes in a v2 shape again
 * (v2 SessionKind has no 'practice'; v2 Card needs front/back).
 */
describe('the v3 Actions contract accepts the v3 shapes', () => {
  type CompleteArgs = Parameters<Actions['completeSession']>[0];
  type RatedCard = NonNullable<ReturnType<Actions['rateCard']>>;
  const counts = { again: 1, hard: 0, good: 2, easy: 0 };

  it('M6: the card rateCard returns is a valid finalCard', () => {
    const rated: RatedCard = makeCard(note(), 0, 'd1', DEFAULT_SRS, NOW, { id: 'c1' });
    const args: CompleteArgs = {
      kind: 'scheduled',
      label: 'German',
      counts,
      total: 3,
      bestRun: 2,
      durationSec: 60,
      fastAnswers: 1,
      studyDay: '2023-11-14',
      finalCard: rated,
      mode: 'mix',
    };
    expect(args.finalCard).toBe(rated);
  });

  it('M5: the stored in-flight marker is valid completeSession input, as it is', () => {
    const marker: InProgressSession = {
      kind: 'practice',
      label: 'Practice',
      counts,
      total: 3,
      bestRun: 2,
      durationSec: 60,
      fastAnswers: 0,
    };
    const args: CompleteArgs = marker;
    expect(args).toBe(marker);
    // The marker has no mode, so a boot-reconciled session records none.
    expect(args.mode).toBeUndefined();
  });

  it('D5: a practice session completes and its payout has kind practice', () => {
    const practice: CompleteArgs = {
      kind: 'practice',
      label: 'Practice',
      counts,
      total: 3,
      bestRun: 2,
      durationSec: 60,
      fastAnswers: 0,
      // Articles exists only as a session mode (never in settings.studyMode),
      // so only the args can carry it.
      mode: 'article',
    };
    const payoutKind: ReturnType<Actions['completeSession']>['kind'] = practice.kind;
    expect(payoutKind).toBe('practice');
  });

  it('the args carry every SessionRecord field new in v3 (mode, scopeLabel)', () => {
    const args: CompleteArgs = {
      kind: 'practice',
      label: 'German · Level A2',
      counts,
      total: 3,
      bestRun: 2,
      durationSec: 60,
      fastAnswers: 0,
      mode: 'article',
    };
    // What completeSession writes into the new SessionRecord keys. `args.mode`
    // does not compile if the args lose `mode` again.
    const record: Pick<SessionRecord, 'kind' | 'mode' | 'scopeLabel'> = {
      kind: args.kind,
      mode: args.mode,
      scopeLabel: args.label,
    };
    expect(record).toEqual({ kind: 'practice', mode: 'article', scopeLabel: 'German · Level A2' });
  });
});

/* ------------------------------------------ the persistence contract */

/*
 * W1-4 (the data-problem screen) reads `useData().persistError` and must be
 * able to compare it with 'too-new' and 'migrate' while DataContext (W1-1) is
 * built in parallel. So DataContext must expose the whole `PersistError`
 * type, not only the values it sets today. `import type` keeps React and
 * AsyncStorage out of this test at run time.
 */
describe('useData() exposes the full PersistError contract', () => {
  type Exposed = ReturnType<typeof useData>['persistError'];

  it('every PersistError value can be read from useData(), and nothing else', () => {
    // Fails to compile if DataContext narrows persistError again.
    const every: Exposed[] = ['read', 'too-new', 'migrate', 'write', null];
    // Fails to compile if DataContext widens it beyond the contract.
    const back: PersistError[] = every;
    expect(back).toHaveLength(5);
  });
});
