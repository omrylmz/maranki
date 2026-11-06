/**
 * Study modes (spec §6.3): how each card of a session is asked.
 *
 *   Flashcards (flash)  tap the card to reveal
 *   Typing     (type)   type the answer, then "Check"            (answerCheck.ts)
 *   Quiz       (mc)     pick the right answer out of 4           (distractors.ts)
 *   Mixed      (mix)    a mode per card, by its status (below)
 *   Articles   (article) der · die · das for German nouns; Practice only
 *
 * THE RULE THAT KEEPS EVERY INVARIANT SAFE (decision D8): every mode ends
 * with the same 4 rating buttons. A mode only SUGGESTS a rating
 * (`suggestRating`); the learner taps the rating. So rateCard, the daily
 * tallies, undo and the M5 marker never see the mode. (Articles shows no
 * rating buttons and writes nothing: it runs only as a Practice session.
 * `planCard` checks this: in any other session kind an Articles card is a
 * plain flashcard, so it is still rated.)
 *
 * MIXED, per card (spec §6.3 table):
 *   New / Not started          → Flashcards
 *   Learning                   → Quiz
 *   Review / Mastered / Check  → Typing if the answer is short, else Flashcards
 * (A Check is a Known card that the scheduler brought back for one test.)
 *
 * FALLBACKS: a card that cannot be asked in its mode is shown as a
 * flashcard — Typing with a long answer ("Long answer — flip instead"),
 * Quiz with fewer than 3 distractors, Articles for a word without der/die/das.
 *
 * FIXED AT QUEUE BUILD (spec §6.1): the session calls `planCards` once, in
 * its useState initializer, and keeps the plan per card id. The plan is a
 * pure function of the card, its face, the mode and the seed
 * `modeSeed(cardId, sessionDayKey)` (the quiz choices and their order), so
 * render stays pure (React Compiler) and a re-queued card ("Again") keeps
 * its plan. "Switch mode" (spec §6.5) calls `planCards` again for the
 * remaining cards only.
 *
 * Also here, because ModeSheet and the session share them: the mode labels,
 * the one-line explanations, the mode row of ModeSheet and the "ways to
 * study" rows that are shown.
 *
 * Pure: no React, no I/O, no clock.
 */
import { cleanAnswer, isTypeable, typingTarget, type AnswerVerdict, type TypingTarget } from './answerCheck';
import type { QuizPool, QuizQuestion } from './distractors';
import type { FaceLibrary, FaceOf } from './face';
import { life, type LifeCard } from './life';
import { splitGermanArticle, termHelpers, isArticleQuizCard, type GermanArticle, type GermanGender } from './lang';
import type { Card, CardFace, FieldBlock, Id, SessionKind, StudyMode } from './model';
import type { Rating } from './types';

/* ---------------------------------------------------------------- modes */

/** How ONE card is asked. ('mix' is not one: it picks one of these per card.) */
export type CardMode = 'flash' | 'type' | 'mc' | 'article';

/** Every study mode, in the order the UI lists them. */
export const STUDY_MODES: readonly StudyMode[] = Object.freeze(['flash', 'type', 'mc', 'mix', 'article']);

/** The UI word of each mode (spec §6.3, §8.11: "Quiz" / "Typing", never `mc` / `type`). */
export const MODE_LABELS: Readonly<Record<StudyMode, string>> = Object.freeze({
  flash: 'Flashcards',
  type: 'Typing',
  mc: 'Quiz',
  mix: 'Mixed',
  article: 'Articles',
});

/** One line under the mode row that says what the chosen mode does. */
export const MODE_HINTS: Readonly<Record<StudyMode, string>> = Object.freeze({
  flash: 'Tap the card to see the answer.',
  type: 'Type the answer, then check it.',
  mc: 'Pick the right answer out of 4.',
  mix: 'New cards as flashcards, learning cards as a quiz, reviews typed.',
  article: 'Choose der, die or das. Doesn’t change your schedule.',
});

/**
 * The modes in ModeSheet's mode row (spec §8.2): Flashcards · Typing · Quiz ·
 * Mixed, plus Articles only when `showArticle`: in a PRACTICE session's
 * "Switch mode", when its scope has enough German nouns (ARTICLE_MIN_CARDS).
 * The deck page never shows Articles in this row: there it is the way row
 * "Practice articles · {n}" (spec §8.2, §9.3).
 */
export function modeChoices(showArticle: boolean): StudyMode[] {
  return showArticle ? ['flash', 'type', 'mc', 'mix', 'article'] : ['flash', 'type', 'mc', 'mix'];
}

/** True for one of the five study modes (a `mode` route param is any string). */
export function isStudyMode(value: unknown): value is StudyMode {
  return typeof value === 'string' && (STUDY_MODES as readonly string[]).includes(value);
}

/** A route param or a stored value → a study mode, or `fallback` when it is not one. */
export function parseStudyMode(value: unknown, fallback: StudyMode): StudyMode {
  return isStudyMode(value) ? value : fallback;
}

/**
 * The seed of a card's per-session choices: the card id and the session day
 * ('2026-10-24'). The same card on the same day gets the same quiz.
 *
 *   modeSeed('c-1', '2026-10-24') → 'c-1|2026-10-24'
 */
export function modeSeed(cardId: Id, dayKey: string): string {
  return `${cardId}|${dayKey}`;
}

/**
 * The mode Mixed asks for, by the card's status (spec §6.3 table), before any
 * fallback: New / Not started → flash; Learning → mc; Review / Mastered /
 * Known (a Check) → type.
 */
export function mixModeFor(card: LifeCard): 'flash' | 'type' | 'mc' {
  switch (life(card)) {
    case 'notStarted':
    case 'new':
      return 'flash';
    case 'learning':
      return 'mc';
    case 'review':
    case 'mastered':
    case 'known':
      return 'type';
  }
}

/* -------------------------------------------------------------- articles */

/** The fewest German nouns a scope needs before ModeSheet offers Articles (spec §6.3, §9.3). */
export const ARTICLE_MIN_CARDS = 4;

/** The three answer buttons of the Articles practice, in this order. */
export const ARTICLE_CHOICES: readonly GermanArticle[] = Object.freeze(['der', 'die', 'das']);

/** What the Articles practice asks for one card. */
export interface ArticleQuestion {
  /** The right answer. */
  article: GermanArticle;
  /** The bare word shown on the card: "Abfahrt". */
  word: string;
  /** For the gender colour of the reveal (der → c.info, die → c.danger, das → c.success). */
  gender: GermanGender;
  /** The term's language, for read-aloud. */
  lang?: string;
}

/** The term block of a face: the first block with role 'term', on the question side first. */
function termBlock(face: CardFace): FieldBlock | undefined {
  return face.prompt.find((b) => b.role === 'term') ?? face.answer.find((b) => b.role === 'term');
}

/** The characters that separate the forms of one term: "der Zauberer / die Zauberin", "der Tisch, -e", "a; b". */
const FORM_SEPARATORS = new Set(['/', ',', ';']);

/**
 * The FIRST form of a term with more than one form (wave 5h, device pass
 * E7 note 5). The forms are split on "/", "," or ";" (with or without
 * spaces around them); a separator inside brackets "(…)" or "[…]" does not
 * count, so "der Kuli (Kugelschreiber, ugs.)" stays one form. The result
 * is trimmed. One linear pass over the text.
 *
 *   firstForm('der Zauberer / die Zauberin') → 'der Zauberer'
 *   firstForm('der Tisch, -e')                 → 'der Tisch'
 *   firstForm('der/die Angestellte')           → 'der'   (so it is still no Articles card)
 *   firstForm('die Abfahrt')                   → 'die Abfahrt'
 */
export function firstForm(term: string): string {
  let depth = 0;
  for (let i = 0; i < term.length; i++) {
    const ch = term.charAt(i);
    if (ch === '(' || ch === '[') depth += 1;
    else if ((ch === ')' || ch === ']') && depth > 0) depth -= 1;
    else if (depth === 0 && FORM_SEPARATORS.has(ch)) return term.slice(0, i).trim();
  }
  return term.trim();
}

/**
 * The Articles question of a card (spec §6.3), or null when the card has no
 * German singular noun: its term field (role 'term') must be in German
 * (`termHelpers(lang).articleQuiz`) and start with der / die / das
 * (`isArticleQuizCard`: no plurals, no "der/die").
 *
 * A term with more than one form asks for its FIRST form only (firstForm,
 * wave 5h). Before, "der Zauberer / die Zauberin" showed the bare word
 * "Zauberer / die Zauberin": the question still had "die" in it, and both
 * articles were right. Now it asks "Zauberer" (answer: der). The same
 * function decides the eligibility, so articleCards, the "≥ 4 such cards"
 * offer (canOfferArticles) and the session's queue all agree.
 *
 *   articleQuestion(face of 'die Abfahrt' (de-DE))                  → { article: 'die', word: 'Abfahrt', gender: 'f', lang: 'de-DE' }
 *   articleQuestion(face of 'der Zauberer / die Zauberin' (de-DE)) → { article: 'der', word: 'Zauberer', gender: 'm', lang: 'de-DE' }
 *   articleQuestion(face of 'the hour' (en-US))                     → null
 */
export function articleQuestion(face: CardFace): ArticleQuestion | null {
  const block = termBlock(face);
  if (!block || !termHelpers(block.lang).articleQuiz) return null;
  const term = firstForm(block.plain);
  if (!isArticleQuizCard(term)) return null;
  const { article, rest, gender } = splitGermanArticle(term);
  if (!article || !gender) return null;
  const question: ArticleQuestion = { article, word: rest, gender };
  if (block.lang) question.lang = block.lang;
  return question;
}

/** A session size as a number of cards: 0 (or a broken value) = no cap. The same rule as schedule.ts. */
function sessionCap(limit: number): number {
  return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : Infinity;
}

/**
 * The cards of an Articles practice session, in the given order: only cards
 * with an Articles question, ONE card per note (both directions of "die
 * Abfahrt" ask the same thing), and at most `limit` cards.
 *
 *   cards  the PRACTICE pool of the scope: its cards after the removals of
 *          spec §6.6 (no Known, Not started, suspended or buried card unless
 *          the scope asks for them — the selectPractice rules), and BEFORE
 *          the session-size cut, so the session is as full as it can be;
 *   limit  the session size, `settings.sessionLimit` (0 = no cap). Every
 *          session is capped by it (spec §1.2 "Session size", §6.6).
 *
 * The deck page's "Practice articles · {n}" count and the session's queue
 * must come from this SAME call, so the number on the button is the session
 * it opens (spec §3.12 "launch count === queue length").
 *
 *   articleCards(practicePool, faceOf, 50) → at most 50 cards, even for 800 nouns
 */
export function articleCards(cards: readonly Card[], faceOf: FaceOf, limit: number): Card[] {
  const cap = sessionCap(limit);
  const seen = new Set<Id>();
  const out: Card[] = [];
  for (const card of cards) {
    if (out.length >= cap) break;
    if (seen.has(card.noteId)) continue;
    if (!articleQuestion(faceOf(card))) continue;
    seen.add(card.noteId);
    out.push(card);
  }
  return out;
}

/**
 * True when a scope has enough German nouns to offer Articles (≥ ARTICLE_MIN_CARDS,
 * spec §9.3): the deck page's "Practice articles · {n}" row, or the Articles
 * chip in a practice session's "Switch mode". `count` = articleCards(…).length.
 */
export function canOfferArticles(count: number): boolean {
  return count >= ARTICLE_MIN_CARDS;
}

/* ------------------------------------------------------------- the plan */

/**
 * Why a card is shown as a flashcard although its mode asked otherwise:
 *   long        Typing: the answer is over 60 characters or has line breaks
 *               (the screen says "Long answer — flip instead");
 *   noText      Typing: the answer has no text (an image, an empty field);
 *   fewChoices  Quiz: fewer than 3 distractors;
 *   noArticle   Articles: the card has no German singular noun.
 * In Mixed there is never a fallback reason: Mixed picks a mode per card by design.
 */
export type Fallback = 'long' | 'noText' | 'fewChoices' | 'noArticle';

/** How one card is asked in this session. */
export interface CardPlan {
  mode: CardMode;
  /** Set when the card is a flashcard because its mode could not be used. */
  fallback: Fallback | null;
  /** Typing: what to type and how to check it. */
  typing: TypingTarget | null;
  /** Quiz: the 4 choices. */
  quiz: QuizQuestion | null;
  /** Articles: the question. */
  article: ArticleQuestion | null;
}

/** What `planCard` needs. */
export interface PlanCtx {
  /** The session's mode (route param or Settings › Study mode). */
  mode: StudyMode;
  /**
   * The session's kind. Articles needs 'practice' (spec §6.3 "Practice
   * only"): it shows no rating buttons, so in a session that changes the
   * schedule its cards would never be rated.
   */
  kind: SessionKind;
  /** The session day (dayKeyOf of the session start), for modeSeed. */
  dayKey: string;
  /** Card → face (useFaces()). */
  faceOf: FaceOf;
  /** Notes and card types by id, for the template's typing field. */
  library: FaceLibrary;
  /** The quiz pool (createQuizPool); needed for Quiz and Mixed. null = no quiz (a fallback). */
  quiz?: QuizPool | null;
}

const NOTHING = { typing: null, quiz: null, article: null } as const;

/** A flashcard plan, with or without a fallback reason. */
function flash(fallback: Fallback | null): CardPlan {
  return { mode: 'flash', fallback, ...NOTHING };
}

/**
 * The plan of one card (see the file header). Deterministic: the same card,
 * face, mode, day and pool always give the same plan.
 */
export function planCard(card: Card, ctx: PlanCtx): CardPlan {
  const mixed = ctx.mode === 'mix';
  const wanted = mixed ? mixModeFor(card) : ctx.mode;
  /** The fallback reason, or none in Mixed. */
  const because = (reason: Fallback): Fallback | null => (mixed ? null : reason);
  switch (wanted) {
    case 'flash':
    case 'mix': // not reachable: mixModeFor never returns 'mix'
      return flash(null);
    case 'type': {
      const face = ctx.faceOf(card);
      const note = ctx.library.noteById.get(card.noteId);
      const type = note ? ctx.library.typeById.get(note.typeId) : undefined;
      const target = typingTarget(face, type, card.ord);
      if (isTypeable(target)) return { mode: 'type', fallback: null, typing: target, quiz: null, article: null };
      // The same cleaning as isTypeable: an answer of only punctuation ("?", "...") has no text to type.
      const empty = !target || cleanAnswer(target.text) === '';
      return flash(because(empty ? 'noText' : 'long'));
    }
    case 'mc': {
      const quiz = ctx.quiz?.question(card, modeSeed(card.id, ctx.dayKey)) ?? null;
      if (quiz) return { mode: 'mc', fallback: null, typing: null, quiz, article: null };
      return flash(because('fewChoices'));
    }
    case 'article': {
      // Not a Practice session: a plain flashcard with its rating buttons, so the card is still rated.
      // (Not a fallback with a message: a Study session never offers Articles, see ModeSheet.)
      if (ctx.kind !== 'practice') return flash(null);
      const article = articleQuestion(ctx.faceOf(card));
      if (article) return { mode: 'article', fallback: null, typing: null, quiz: null, article };
      return flash(because('noArticle'));
    }
  }
}

/**
 * The plans of a session's cards, by card id (a re-queued copy of a card
 * has the same id, so it keeps its plan). Call it once when the queue is
 * built, and again for the remaining cards after "Switch mode".
 */
export function planCards(cards: readonly Card[], ctx: PlanCtx): Map<Id, CardPlan> {
  const plans = new Map<Id, CardPlan>();
  for (const card of cards) {
    if (!plans.has(card.id)) plans.set(card.id, planCard(card, ctx));
  }
  return plans;
}

/* ---------------------------------------------------- suggested rating */

/** What happened in the card's mode before the learner rates it. */
export type ModeOutcome =
  | { mode: 'flash' }
  | { mode: 'type'; verdict: AnswerVerdict }
  | { mode: 'mc'; right: boolean };

/**
 * The rating button to outline (spec §6.3, §6.4). The learner still taps
 * the rating; this is only a suggestion.
 *   Typing   exact → Good, close → Hard, wrong → Again
 *   Quiz     right → Good, wrong → Again
 *   Flashcards → no suggestion (null)
 *   A used hint outlines Hard, unless the answer was wrong (Again stays).
 */
export function suggestRating(outcome: ModeOutcome, hintUsed: boolean = false): Rating | null {
  let base: Rating | null;
  switch (outcome.mode) {
    case 'flash':
      base = null;
      break;
    case 'type':
      base = outcome.verdict === 'exact' ? 'good' : outcome.verdict === 'close' ? 'hard' : 'again';
      break;
    case 'mc':
      base = outcome.right ? 'good' : 'again';
      break;
  }
  if (hintUsed && base !== 'again') return 'hard';
  return base;
}

/* ------------------------------------------------------ ModeSheet rows */

/** One "way to study" row of ModeSheet (deck page "More ways to study", spec §8.2). */
export interface StudyWay {
  key: string;
  /** "Study ahead", "Practice all", "Practice your hardest", "Practice articles". */
  label: string;
  /** The number of cards the row opens. */
  count: number;
  /** A second line, e.g. 'Doesn’t change your schedule.' */
  sub?: string;
  onPress: () => void;
}

/** The rows that are shown: only those whose count is above 0 (spec §8.2 / §6.10 "hidden when 0"). */
export function shownWays<W extends Pick<StudyWay, 'count'>>(ways: readonly W[] | undefined): W[] {
  return (ways ?? []).filter((w) => Number.isFinite(w.count) && w.count > 0);
}

/**
 * The title of a way row: label and count, as the spec writes them.
 *
 *   wayTitle('Study ahead', 12)    → 'Study ahead · 12'
 *   wayTitle('Practice all', 1240) → 'Practice all · 1,240'
 */
export function wayTitle(label: string, count: number): string {
  return `${label} · ${count.toLocaleString('en-US')}`;
}
