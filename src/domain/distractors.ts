/**
 * Quiz mode: the 3 wrong answers ("distractors") next to the right one
 * (spec §6.3 "Quiz").
 *
 *   Question: die Stunde
 *     ( ) the minute    ( ) the hour    ( ) the day    ( ) the week
 *
 * The rules for a distractor:
 *   - from the SAME deck, the SAME card type and the SAME direction (ord), so
 *     every choice looks like the right kind of answer;
 *   - never a SIBLING (another direction of the same note): its answer is
 *     the question itself;
 *   - never the same folded text as the right answer or as another choice
 *     ("The hour." and "the hour" are the same text). It also never shares
 *     an ALTERNATIVE with them: "building, house" next to "house" would be a
 *     second right answer (answerCheck.ts `answerAlternatives` splits them at
 *     , ; / — with the answer's language, so a German "der/die Angestellte"
 *     gives "der Angestellte" and "die Angestellte", never a bare "der" that
 *     every "der/die" noun would share);
 *   - PREFER a card with the same badge values (the same Level B1, the same
 *     Type noun), then a card whose answer has a similar length.
 *   Fewer than 3 distractors → no quiz: the card is shown as a flashcard.
 *
 * Order and choice are SEEDED, not random (React Compiler: no Math.random()
 * during render; the session fixes them once, in its useState initializer).
 * The seed is `cardId + '|' + sessionDayKey` (modes.ts `modeSeed`): the same
 * card on the same day always gets the same 4 choices in the same order.
 *
 * Speed: the deck of a big import has 16,000 cards. `createQuizPool` builds
 * the candidates of a deck only when the first card of that deck needs a
 * quiz, and keeps at most QUIZ_GROUP_CAP of them per (deck, card type,
 * direction), chosen by a seeded hash. Every quiz question then reads at most
 * that many candidates.
 *
 * Pure: no React, no I/O, no clock.
 */
import { answerAlternatives, answerKey } from './answerCheck';
import type { FaceLibrary, FaceOf } from './face';
import { fnv1a, seededShuffle } from './hash';
import type { Card, CardFace, Id } from './model';

/** How many wrong answers a quiz needs (spec §6.3: 4 answers = the right one + 3). */
export const DISTRACTOR_COUNT = 3;

/** The most candidates kept per (deck, card type, direction). See "Speed" in the file header. */
export const QUIZ_GROUP_CAP = 500;

/** One card as a possible quiz answer. Built by `quizCandidate`. */
export interface QuizCandidate {
  id: Id;
  noteId: Id;
  /** Deck + card type + direction: only candidates of the same group are compared. */
  group: string;
  /** The answer as shown on the choice button (face.answerPlain). */
  text: string;
  /** The folded keys of the text and of each alternative in it (answerCheck rules). */
  keys: string[];
  /** The badge values, as `field index + ':' + folded value` ('4:b1'). */
  badges: string[];
  /** Characters in the text, for "similar length". */
  length: number;
}

/** A finished quiz: the 4 choices in their seeded order, and which one is right. */
export interface QuizQuestion {
  choices: string[];
  /** Index of the right answer in `choices`. */
  answerIndex: number;
}

/** The group key of a card: deck + card type + direction. */
export function quizGroup(deckId: Id, typeId: Id, ord: number): string {
  return `${deckId}\u0000${typeId}\u0000${ord}`;
}

/**
 * A card → a quiz candidate, or null when its answer has no text (an image
 * only, an empty field): such a card is never a choice, and it cannot be
 * asked as a quiz either.
 *
 *   quizCandidate(card, faceOf(card), note.typeId)
 *     → { text: 'the hour', keys: ['the hour'], badges: ['4:a1'], … }
 */
export function quizCandidate(card: Pick<Card, 'id' | 'noteId' | 'deckId' | 'ord'>, face: CardFace, typeId: Id): QuizCandidate | null {
  const text = face.answerPlain.trim();
  // The answer headline's language: German answers have German alternatives (see the file header).
  const alternatives = answerAlternatives(text, { lang: face.answer[0]?.lang });
  if (alternatives.length === 0) return null;
  const keys = Array.from(new Set(alternatives.map(answerKey)));
  const badges = face.badges.map((b) => `${b.field}:${answerKey(b.plain)}`).filter((b) => !b.endsWith(':'));
  return {
    id: card.id,
    noteId: card.noteId,
    group: quizGroup(card.deckId, typeId, card.ord),
    text,
    keys,
    badges,
    length: Array.from(text).length,
  };
}

/** True when two candidates share a folded text or an alternative. */
function overlaps(a: QuizCandidate, b: QuizCandidate): boolean {
  for (const key of a.keys) if (b.keys.includes(key)) return true;
  return false;
}

/** How many badge values two candidates share (more = a better distractor). */
function sharedBadges(a: QuizCandidate, b: QuizCandidate): number {
  let n = 0;
  for (const badge of a.badges) if (b.badges.includes(badge)) n++;
  return n;
}

/**
 * How far two answer lengths are apart, in 3 steps (lower = more similar):
 *   0  within 25%   ("the hour" / "the week")
 *   1  within 50%
 *   2  further      ("the hour" / "a unit of time of sixty minutes")
 */
function lengthTier(a: number, b: number): number {
  const ratio = Math.abs(a - b) / Math.max(a, b, 1);
  return ratio <= 0.25 ? 0 : ratio <= 0.5 ? 1 : 2;
}

/** Mix two 32-bit hashes into one (a seeded tie-break that changes with the seed). */
function mix(a: number, b: number): number {
  let h = Math.imul(a ^ b, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** A candidate with its sort keys. */
interface Ranked {
  c: QuizCandidate;
  shared: number;
  tier: number;
  tie: number;
}

/** Better first: more shared badges, then a closer length, then the seeded tie-break, then the id. */
function compareRanked(x: Ranked, y: Ranked): number {
  return (
    y.shared - x.shared ||
    x.tier - y.tier ||
    x.tie - y.tie ||
    (x.c.id < y.c.id ? -1 : x.c.id > y.c.id ? 1 : 0)
  );
}

/**
 * The 3 distractors for `target` from `pool` (see the file header for the
 * rules), best first, or null when there are fewer than 3. `pool` may hold
 * any cards: only candidates of the target's group are used, and the target
 * and its siblings are skipped.
 *
 *   pickDistractors(stunde, poolOfTheDeck, 'c-1|2026-10-24') → [minute, day, week]
 */
export function pickDistractors(
  target: QuizCandidate,
  pool: readonly QuizCandidate[],
  seed: string,
): QuizCandidate[] | null {
  const seedHash = fnv1a(seed);
  const ranked: Ranked[] = [];
  for (const c of pool) {
    if (c.group !== target.group || c.id === target.id || c.noteId === target.noteId) continue;
    if (overlaps(c, target)) continue;
    ranked.push({ c, shared: sharedBadges(target, c), tier: lengthTier(target.length, c.length), tie: mix(seedHash, fnv1a(c.id)) });
  }
  if (ranked.length < DISTRACTOR_COUNT) return null;
  ranked.sort(compareRanked);

  // Best first, and never two choices that share a text or an alternative.
  const picked: QuizCandidate[] = [];
  for (const r of ranked) {
    if (picked.some((p) => overlaps(p, r.c))) continue;
    picked.push(r.c);
    if (picked.length === DISTRACTOR_COUNT) return picked;
  }
  return null;
}

/**
 * The quiz for `target`: the right answer and 3 distractors, in a seeded
 * order. null when there are fewer than 3 distractors (the card is then a
 * flashcard, spec §6.3).
 *
 *   quizQuestion(stunde, pool, seed) → { choices: ['the day', 'the hour', 'the week', 'the minute'], answerIndex: 1 }
 */
export function quizQuestion(target: QuizCandidate, pool: readonly QuizCandidate[], seed: string): QuizQuestion | null {
  const distractors = pickDistractors(target, pool, seed);
  if (!distractors) return null;
  const order = seededShuffle([0, 1, 2, 3], seed);
  const all = [target.text, ...distractors.map((d) => d.text)];
  return { choices: order.map((i) => all[i]), answerIndex: order.indexOf(0) };
}

/* ------------------------------------------------------------------ pool */

/** The quiz questions of one session. Built by `createQuizPool`. */
export interface QuizPool {
  /**
   * The quiz for one card, or null (no text, or fewer than 3 distractors).
   * `seed` = modeSeed(card.id, sessionDayKey).
   */
  question(card: Card, seed: string): QuizQuestion | null;
}

/**
 * The cards of a big group, cut to `cap`: the cards with the smallest seeded
 * hash of their id. The same cards + the same seed → the same cut.
 */
function sampleGroup(cards: Card[], cap: number, seed: string): Card[] {
  if (cards.length <= cap) return cards;
  const seedHash = fnv1a(seed);
  return cards
    .map((card) => ({ card, h: mix(seedHash, fnv1a(card.id)) }))
    .sort((a, b) => a.h - b.h || (a.card.id < b.card.id ? -1 : a.card.id > b.card.id ? 1 : 0))
    .slice(0, cap)
    .map((x) => x.card);
}

/**
 * The quiz pool of a session. `cards` = every card of the library (the
 * distractors come from the target's whole deck, not only from the session
 * queue); `library` gives each card's card type; `faceOf` its text
 * (useFaces()). `sampleSeed` (the session day key) picks the candidates of a
 * group that has more than QUIZ_GROUP_CAP cards.
 *
 * Nothing is computed until the first `question()` call, and then only for
 * the deck of that card, so creating a pool in the session's useState
 * initializer costs nothing. The pool keeps what it built (a cache), so the
 * same question asked twice gives the same object.
 *
 *   const quiz = createQuizPool(state.cards, library, faceOf, dayKey);
 *   quiz.question(card, modeSeed(card.id, dayKey)) → { choices, answerIndex } | null
 */
export function createQuizPool(
  cards: readonly Card[],
  library: Pick<FaceLibrary, 'noteById'>,
  faceOf: FaceOf,
  sampleSeed: string = '',
): QuizPool {
  let byDeck: Map<Id, Card[]> | null = null;
  const groupsByDeck = new Map<Id, Map<string, QuizCandidate[]>>();
  const questions = new Map<string, QuizQuestion | null>();

  const typeIdOf = (card: Pick<Card, 'noteId'>): Id | undefined => library.noteById.get(card.noteId)?.typeId;

  /** The candidates of every group of one deck (built once per deck). */
  const groupsOf = (deckId: Id): Map<string, QuizCandidate[]> => {
    const hit = groupsByDeck.get(deckId);
    if (hit) return hit;
    if (!byDeck) {
      byDeck = new Map();
      for (const card of cards) {
        const list = byDeck.get(card.deckId);
        if (list) list.push(card);
        else byDeck.set(card.deckId, [card]);
      }
    }
    const byGroup = new Map<string, Card[]>();
    for (const card of byDeck.get(deckId) ?? []) {
      const typeId = typeIdOf(card);
      if (typeId === undefined) continue; // a card without a note has no card type
      const key = quizGroup(card.deckId, typeId, card.ord);
      const list = byGroup.get(key);
      if (list) list.push(card);
      else byGroup.set(key, [card]);
    }
    const groups = new Map<string, QuizCandidate[]>();
    for (const [key, list] of byGroup) {
      const out: QuizCandidate[] = [];
      for (const card of sampleGroup(list, QUIZ_GROUP_CAP, sampleSeed)) {
        const typeId = typeIdOf(card);
        const candidate = typeId === undefined ? null : quizCandidate(card, faceOf(card), typeId);
        if (candidate) out.push(candidate);
      }
      groups.set(key, out);
    }
    groupsByDeck.set(deckId, groups);
    return groups;
  };

  return {
    question(card, seed) {
      const cacheKey = `${card.id}\u0000${seed}`;
      if (questions.has(cacheKey)) return questions.get(cacheKey) ?? null;
      const typeId = typeIdOf(card);
      const target = typeId === undefined ? null : quizCandidate(card, faceOf(card), typeId);
      const pool = target ? groupsOf(card.deckId).get(target.group) ?? [] : [];
      const question = target ? quizQuestion(target, pool, seed) : null;
      questions.set(cacheKey, question);
      return question;
    },
  };
}
