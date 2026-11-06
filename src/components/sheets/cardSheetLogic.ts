/**
 * The decisions of the CardSheet (spec §8.4, §6.5 "Card info", §7 #19-21
 * and #49, unit A1). Pure: no React, no clock — the caller passes `now`.
 * CardSheet.tsx holds only React state and layout; every choice it makes
 * ("which rows show", "what does this toggle say", "what does this tap do")
 * is a function here, so it is tested without a phone.
 *
 *   die Reise                                         🔊   ← faceLayout: headline
 *   the trip                                               ←             subline
 *   GRAMMAR   -n · EXAMPLE  Die Reise war lang. · LEVEL B1 ←             rows
 *   ● Review · next in 4 days                              ← cardStatus
 *   🗂 German › Vocabulary › B1                             ← deckPath
 *   (tag chips)                                            ← libraryTagHref
 *   [ ♡ Favorite ] [ ⚑ Flag ] [ ⏸ Suspend ]                ← flagToggles
 *   STATUS ( Not started ) ( In queue ) ( Known )          ← statusSegments / statusChange
 *   Reset progress…                     Reschedule…        ← cardSheetSections
 *   History: 7 reviews · 1 lapse · last: 3 days ago (Good) ← historyLineOf
 *   [ ✎ Edit card ]   Practice this card · Move to deck… · Delete card…
 *
 * A session's "Card info" BEFORE the card is revealed shows the question
 * only, and "The answer shows after you reveal the card." (sheetFace).
 *
 * What a change touches (glossary §1.2):
 *   - a card = ONE direction. Favorite, Flag, Suspend, Status, Reset and
 *     Reschedule change only this card;
 *   - the information you entered (the note) has one card per direction.
 *     "Move to deck…" and "Delete card…" act on the note, so on ALL its
 *     directions, and the sheet says so.
 */
import { blockText, speechOf, type SpokenText } from '../../domain/face';
import { directionLabel } from '../../domain/facets';
import { isBuried, life, LIFE_LABELS } from '../../domain/life';
import type {
  Card,
  CardFace,
  DataStateV3,
  Deck,
  FieldBlock,
  Id,
  LifeKey,
  Note,
  NoteType,
  RevlogRow,
} from '../../domain/model';
import { serializeQuery } from '../../domain/query';
import { isSpeakerBlock } from '../../domain/render';
import { cardLookupOf, decksById, libraryIndexOf } from '../../domain/scope';
import { oneLine } from '../../domain/text';
import { cardHistoryLine, summarizeCardHistory } from '../../store/history';
import { nextReviewLong } from '../../utils/dateFormatting';
import { canReschedule } from '../study/rescheduleLogic';

/* ------------------------------------------------------------------ copy */

/** The sheet's fixed texts (exact copy, spec §8.4). */
export const CARD_SHEET_COPY = {
  status: 'Status',
  reset: 'Reset progress…',
  reschedule: 'Reschedule…',
  edit: 'Edit card',
  practice: 'Practice this card',
  practiceSub: 'Doesn’t change your schedule.',
  move: 'Move to deck…',
  moveTitle: 'Move to deck',
  delete: 'Delete card…',
  deleteTitle: 'Delete this card?',
  deleteConfirm: 'Delete card',
  resetTitle: 'Start this card again as New?',
  resetBody: 'Its history is kept.',
  resetConfirm: 'Reset progress',
  cancel: 'Cancel',
  missing: 'This card is no longer here.',
  noHistory: 'History: no reviews in Maranki yet',
  speak: 'Read aloud',
  /** A session's "Card info" before the reveal: in place of the answer (sheetFace, wave 5h). */
  answerHidden: 'The answer shows after you reveal the card.',
} as const;

/* ------------------------------------------------------------ the data */

/** Everything the sheet shows about one card, read from the store. */
export interface CardSheetSource {
  card: Card;
  /** The card's note (its text, tags, section). null only in damaged data. */
  note: Note | null;
  /** The note's card type. null only in damaged data. */
  type: NoteType | null;
  /** The card's deck. null only in damaged data. */
  deck: Deck | null;
  /** How many cards (directions) the note has, this one included. */
  siblings: number;
}

type SourceState = Pick<DataStateV3, 'cards' | 'notes' | 'noteTypes' | 'decks'>;

/** The card `cardId` and what belongs to it, or null when there is no such card (deleted). */
export function cardSheetSourceOf(state: SourceState, cardId: Id | null): CardSheetSource | null {
  if (!cardId) return null;
  const { cardById, cardIdsByNote } = cardLookupOf(state.cards);
  const card = cardById.get(cardId);
  if (!card) return null;
  const index = libraryIndexOf(state);
  const note = index.noteById.get(card.noteId) ?? null;
  const type = note ? (index.typeById.get(note.typeId) ?? null) : null;
  const deck = decksById(state.decks).get(card.deckId) ?? null;
  const siblings = Math.max(1, cardIdsByNote.get(card.noteId)?.length ?? 1);
  return { card, note, type, deck, siblings };
}

/**
 * The selector of the sheet (for useStateV3): cardSheetSourceOf, but the
 * SAME object while the card, its note, card type, deck and sibling count
 * stay the same. So a change to another card does not re-render the sheet.
 */
export function cardSheetSourceReader(cardId: Id | null): (state: SourceState) => CardSheetSource | null {
  let last: CardSheetSource | null = null;
  return (state) => {
    const next = cardSheetSourceOf(state, cardId);
    if (
      next &&
      last &&
      next.card === last.card &&
      next.note === last.note &&
      next.type === last.type &&
      next.deck === last.deck &&
      next.siblings === last.siblings
    ) {
      return last;
    }
    last = next;
    return next;
  };
}

/* ------------------------------------------------------------ the face */

/** How the sheet lays out a card's face. */
export interface FaceLayout {
  /** The question's first block (big serif line). */
  headline: FieldBlock | null;
  /** The answer's first block that does not repeat the headline (the line under it). */
  subline: FieldBlock | null;
  /** Every other field, once, as labelled rows: question fields, answer fields, then badges (Level). */
  rows: FieldBlock[];
}

/**
 * True when an answer block shows the SAME text of the same field as the
 * headline. That happens on a dictation card (Anki's
 * '{{tts de_DE:Word}}{{type:Word}}'): its question is the 🔊 speaker block
 * of Word, the sheet shows that word as the headline (headlineText), and the
 * answer starts with Word again. A cloze text is the same field on both
 * sides too, but with OTHER text ("[…] is in France" / "Paris is in
 * France"), so it is not a repeat.
 */
function repeatsHeadline(block: FieldBlock, headline: FieldBlock | null): boolean {
  return headline !== null && block.field === headline.field && block.plain === headline.plain;
}

/**
 * The face as headline, subline and labelled rows. A field that shows on
 * both sides (a cloze text: hidden on the question, revealed on the answer)
 * is one row, with the ANSWER version, at the place it first appears.
 * Fields of the headline and the subline are not repeated as rows. Hidden
 * and empty fields are left out later, by FieldRows.
 *
 * The subline is the first answer block that does not repeat the headline
 * (repeatsHeadline). So a dictation card shows "das Haus" once, and its
 * meaning "the house" under it:
 *
 *   faceLayout(dictation)  // prompt [🔊 Word], answer [Word, Meaning]
 *     → { headline: Word, subline: Meaning, rows: [] }
 */
export function faceLayout(face: CardFace): FaceLayout {
  const headline = face.prompt[0] ?? null;
  const subline = face.answer.find((block) => !repeatsHeadline(block, headline)) ?? null;
  const taken = new Set<number>();
  if (headline) taken.add(headline.field);
  if (subline) taken.add(subline.field);
  const rows: FieldBlock[] = [];
  const position = new Map<number, number>();
  const otherAnswers = face.answer.filter((block) => block !== subline);
  for (const block of [...face.prompt.slice(1), ...otherAnswers, ...face.badges]) {
    if (taken.has(block.field)) continue;
    const at = position.get(block.field);
    if (at === undefined) {
      position.set(block.field, rows.length);
      rows.push(block);
    } else {
      rows[at] = block;
    }
  }
  return { headline, subline, rows };
}

/**
 * The text of a headline block. A dictation question shows only "🔊" on
 * the card; the sheet is not a quiz, so it shows the word itself.
 */
export function headlineText(block: FieldBlock | null): string {
  if (!block) return '';
  return isSpeakerBlock(block) ? block.plain : blockText(block);
}

/**
 * The QUESTION side of a face as headline and labelled rows, with no
 * answer block at all: the question's first block is the headline, there
 * is no subline (it is an answer block), and the rows are the other
 * question fields, then the badges (Level). These are the things the study
 * card shows on its front (its badges are on the top row). A field that is
 * on both sides (a cloze text) keeps its QUESTION version ("[…] is in France").
 *
 *   questionLayout(face of 'die Reise' → 'the trip', Level B1)
 *     → { headline: die Reise, subline: null, rows: [Level] }
 */
export function questionLayout(face: CardFace): FaceLayout {
  const headline = face.prompt[0] ?? null;
  const taken = new Set<number>();
  if (headline) taken.add(headline.field);
  const rows: FieldBlock[] = [];
  for (const block of [...face.prompt.slice(1), ...face.badges]) {
    if (taken.has(block.field)) continue;
    taken.add(block.field);
    rows.push(block);
  }
  return { headline, subline: null, rows };
}

/** What the sheet shows as the card's face (sheetFace). */
export interface SheetFace {
  layout: FaceLayout;
  /** The headline's text (the big serif line). */
  headline: string;
  /** What the sheet's 🔊 speaks. */
  spoken: SpokenText;
  /** True when the answer is hidden: the sheet says CARD_SHEET_COPY.answerHidden under the question. */
  answerHidden: boolean;
}

/**
 * The face the sheet shows.
 *
 *   - Everywhere (Library, Today, and a session's "Card info" AFTER the
 *     reveal): the whole card (faceLayout, headlineText); 🔊 speaks the question.
 *   - A session's "Card info" BEFORE the learner revealed the card on
 *     screen (`hideAnswer`, wave 5h, device pass E7 note 7): the question
 *     only (questionLayout), as the card shows it. Card info showed the
 *     answer there: a spoiler. So a dictation question stays its "🔊"
 *     (blockText), not the word it reads aloud. When the session asks
 *     something else than the face's question (`question`, Articles: the
 *     bare word "Zauberer", whose article is the answer), the sheet shows
 *     and speaks that, with only the badges as rows (the Articles card
 *     shows no other question field and no picture).
 *
 *   sheetFace(face)                                      → whole card
 *   sheetFace(face, { hideAnswer: true })                → question only, answerHidden
 *   sheetFace(face, { hideAnswer: true, question: { text: 'Zauberer', lang: 'de-DE' } })
 *     → headline 'Zauberer', no headline block, rows = badges, answerHidden
 */
export function sheetFace(face: CardFace, opts: { hideAnswer?: boolean; question?: SpokenText } = {}): SheetFace {
  if (!opts.hideAnswer) {
    const layout = faceLayout(face);
    return { layout, headline: headlineText(layout.headline), spoken: speechOf(face, 'prompt'), answerHidden: false };
  }
  if (opts.question) {
    // The badges only (Level), once each: with no question blocks, questionLayout keeps just them.
    const rows = questionLayout({ ...face, prompt: [] }).rows;
    return { layout: { headline: null, subline: null, rows }, headline: opts.question.text, spoken: opts.question, answerHidden: true };
  }
  const layout = questionLayout(face);
  return { layout, headline: blockText(layout.headline ?? undefined), spoken: speechOf(face, 'prompt'), answerHidden: true };
}

/** The image names (`<img src>`) of a block, in order. */
export function blockImages(block: FieldBlock | null): string[] {
  if (!block) return [];
  const out: string[] = [];
  for (const line of block.lines) for (const part of line) if (part.t === 'img' && part.src) out.push(part.src);
  return out;
}

/** The card as a short one-line name for snackbars and the delete question: "die Reise", or "Card". */
export function cardLabel(face: CardFace, max = 40): string {
  const head = face.prompt[0];
  const text = oneLine(head ? head.plain : face.promptPlain);
  if (text === '') return 'Card';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/* ------------------------------------------------------------ status line */

/**
 * When a card with a schedule comes back, in words:
 *   due <= now          → 'due now'
 *   in less than 1 hour → 'next in 10 minutes'
 *   later today         → 'next in 3 hours'
 *   tomorrow            → 'next tomorrow'
 *   later               → 'next in 4 days'   (local calendar days, DST-safe)
 *   30 days or more     → 'next in 2 months', 'next in 1.2 years'
 *
 * The ONE rule of the app (src/utils/dateFormatting.ts `reviewWait`, wave
 * 5i): the Library row says the same number in its short form ("next 4d").
 * Before, the row rounded the time left and the sheet counted calendar
 * days, so one card read "next 4d" in the row and "next in 3 days" here.
 */
export function nextReviewText(due: number, now: number): string {
  return nextReviewLong(due, now);
}

/** The status line of a card: "Review · next in 4 days · suspended". */
export interface CardStatus {
  /** The lifecycle status (the dot colour). */
  key: LifeKey;
  /** The status word (glossary §1.2): "Review". */
  word: string;
  /** The word, then the details: ["Review", "next in 4 days", "suspended"]. */
  parts: string[];
  /** The parts joined with " · ". */
  text: string;
}

/**
 * The status word and what it means right now. A suspended or buried card,
 * or a card in a paused deck, says so: its "next in 4 days" alone would be
 * a promise Study does not keep.
 */
export function cardStatus(card: Card, deck: Pick<Deck, 'active'> | null, now: number): CardStatus {
  const key = life(card);
  const parts: string[] = [LIFE_LABELS[key]];
  switch (key) {
    case 'notStarted':
      parts.push('not in your study queue');
      break;
    case 'new':
      parts.push('waiting for its first study');
      break;
    case 'learning':
    case 'review':
    case 'mastered':
      parts.push(nextReviewText(card.due, now));
      break;
    case 'known':
      break;
  }
  if (card.suspended) parts.push('suspended');
  if (isBuried(card, now)) parts.push('buried until tomorrow');
  if (deck && deck.active === false) parts.push('deck paused');
  return { key, word: parts[0], parts, text: parts.join(' · ') };
}

/** "German › Vocabulary › B1": the deck, then the parts of the section (subdeck) path. */
export function deckPath(deck: Pick<Deck, 'name'> | null, section: string | null | undefined): string {
  const parts = [deck ? deck.name : 'No deck'];
  for (const part of String(section ?? '').split('::')) {
    const clean = part.trim();
    if (clean !== '') parts.push(clean);
  }
  return parts.join(' › ');
}

/* ------------------------------------------------------------------ tags */

/** The tags to show: as stored, without empty or repeated ones. */
export function visibleTags(tags: readonly string[] | null | undefined): string[] {
  const out: string[] = [];
  for (const tag of tags ?? []) {
    if (typeof tag !== 'string') continue;
    const clean = tag.trim();
    if (clean !== '' && !out.includes(clean)) out.push(clean);
  }
  return out;
}

/** A tag on its chip: "Algo::Core_Patterns" → "Algo › Core_Patterns". */
export function tagChipLabel(tag: string): string {
  return tag
    .split('::')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join(' › ');
}

/**
 * Where a tag chip goes (spec §4.6, §7 #49): the Library with ONE chip,
 * "Tag: …". The route params are `q` (the Query as JSON) and `nonce` (so
 * the Library knows a new request arrived, even for the same tag twice).
 * The Library route comes with wave 4b, so this is a plain string href; the
 * caller casts it to `Href`. `nonce` comes from the press handler
 * (`String(Date.now())`), never from render.
 *
 *   libraryTagHref('Algo', '17') → '/(tabs)/library?q=%7B%22tags%22%3A%5B%22algo%22%5D%7D&nonce=17'
 */
export function libraryTagHref(tag: string, nonce: string): string {
  const q = serializeQuery({ tags: [tag] });
  return `/(tabs)/library?q=${encodeURIComponent(q)}&nonce=${encodeURIComponent(nonce)}`;
}

/* ------------------------------------------------------- favorite / flag / suspend */

/** The three markers the sheet toggles. They never change the schedule. */
export type SheetFlag = 'fav' | 'flagged' | 'suspended';

export interface FlagToggle {
  key: SheetFlag;
  /** The visible label: the action ("Flag" when off, "Unflag" when on). */
  label: string;
  /** The screen-reader name of the switch ("Flag"); its state says on or off. */
  name: string;
  /** Ionicons glyph: filled when on, outline when off. */
  icon: string;
  /** Is the marker set on the card now? (The toggle is drawn active.) */
  on: boolean;
}

const FLAG_ORDER: readonly SheetFlag[] = ['fav', 'flagged', 'suspended'];

const FLAG_TEXT: Readonly<Record<SheetFlag, { name: string; off: string; on: string; iconOff: string; iconOn: string }>> = {
  fav: { name: 'Favorite', off: 'Favorite', on: 'Unfavorite', iconOff: 'heart-outline', iconOn: 'heart' },
  flagged: { name: 'Flag', off: 'Flag', on: 'Unflag', iconOff: 'flag-outline', iconOn: 'flag' },
  suspended: { name: 'Suspend', off: 'Suspend', on: 'Unsuspend', iconOff: 'pause-circle-outline', iconOn: 'pause-circle' },
};

/** Is this marker set on the card? (An absent key means false.) */
export function flagOn(card: Pick<Card, SheetFlag>, key: SheetFlag): boolean {
  return card[key] === true;
}

/**
 * The three toggles with their CURRENT state (spec §7 #19, #20: real
 * toggles; the label is the action, so a flagged card shows "Unflag" and a
 * filled flag — the flag state is always visible).
 */
export function flagToggles(card: Pick<Card, SheetFlag>): FlagToggle[] {
  return FLAG_ORDER.map((key) => {
    const on = flagOn(card, key);
    const text = FLAG_TEXT[key];
    return { key, label: on ? text.on : text.off, name: text.name, icon: on ? text.iconOn : text.iconOff, on };
  });
}

/** The setFlags patch that flips one marker: { flagged: true } for an unflagged card. */
export function flagPatch(card: Pick<Card, SheetFlag>, key: SheetFlag): Partial<Record<SheetFlag, boolean>> {
  const patch: Partial<Record<SheetFlag, boolean>> = {};
  patch[key] = !flagOn(card, key);
  return patch;
}

/** The snackbar after a toggle; `on` = the NEW value. */
export function flagSnack(key: SheetFlag, on: boolean): string {
  switch (key) {
    case 'fav':
      return on ? 'Added to Favorites' : 'Removed from Favorites';
    case 'flagged':
      return on ? 'Flagged' : 'Unflagged';
    case 'suspended':
      return on ? 'Suspended' : 'Unsuspended';
  }
}

/* ------------------------------------------------------------ status control */

/** The three segments of the Status control (spec §8.4). */
export type StatusSegment = 'notStarted' | 'queue' | 'known';

export const STATUS_LABELS: Readonly<Record<StatusSegment, string>> = {
  notStarted: 'Not started',
  queue: 'In queue',
  known: 'Known',
};

/** True for a segment id (the Status control reports a plain string). */
export function isStatusSegment(id: string): id is StatusSegment {
  return id === 'notStarted' || id === 'queue' || id === 'known';
}

/** The segment a card is in: Known, Not started, or (every other status) In queue. */
export function statusSegmentOf(card: Card): StatusSegment {
  const key = life(card);
  if (key === 'known') return 'known';
  if (key === 'notStarted') return 'notStarted';
  return 'queue';
}

/**
 * The segments to offer. "Not started" only for a card that was NEVER
 * studied (reps 0): a studied card has a schedule to keep (triage.ts
 * setNotStarted skips it), so the choice would do nothing.
 */
export function statusSegments(card: Card): { id: StatusSegment; label: string }[] {
  const ids: StatusSegment[] = card.reps === 0 ? ['notStarted', 'queue', 'known'] : ['queue', 'known'];
  return ids.map((id) => ({ id, label: STATUS_LABELS[id] }));
}

/** The store command behind a segment (spec §3.6). */
export type StatusCommand = 'setNotStarted' | 'learn' | 'markKnown';

/**
 * What a tap on segment `target` does, or null when it does nothing (the
 * card is already there, or "Not started" for a studied card):
 *   Not started → setNotStarted  "Moved back to Not started"
 *   In queue    → learn          "Added to your queue" (from Not started)
 *                                "No longer marked as known" (from Known)
 *   Known       → markKnown      "Marked as known"
 */
export function statusChange(card: Card, target: StatusSegment): { command: StatusCommand; snack: string } | null {
  const current = statusSegmentOf(card);
  if (current === target) return null;
  switch (target) {
    case 'notStarted':
      return card.reps === 0 ? { command: 'setNotStarted', snack: 'Moved back to Not started' } : null;
    case 'queue':
      return {
        command: 'learn',
        snack: current === 'known' ? 'No longer marked as known' : 'Added to your queue',
      };
    case 'known':
      return { command: 'markKnown', snack: 'Marked as known' };
  }
}

/* ------------------------------------------------------------ which rows show */

export interface CardSheetSections {
  /** The rows that change something: toggles, Status, Reset/Reschedule, Edit, Practice, Move, Delete. */
  edit: boolean;
  /** "Reset progress…": only a card with progress (studied, or Known). */
  reset: boolean;
  /** "Reschedule…": 'offer' for a card with a schedule; 'notStudied' shows the note instead; null = hidden. */
  reschedule: 'offer' | 'notStudied' | null;
  /** "Practice this card": only when a practice session would really show it. */
  practice: boolean;
  /** Tag chips open the Library (not in the read-only sheet, which is opened from inside a session). */
  tagsTappable: boolean;
  /** Card type, direction, repetitions, lapses and ease (the read-only "Card info", spec §6.5). */
  info: boolean;
}

/**
 * Which parts of the sheet show. `practiceCount` is the length of the
 * practice session of this one card (useSessionLength): a Known, Not
 * started, suspended or buried card is not practised, and a button that
 * opens an empty session would be a dead end.
 *
 * The read-only sheet (session "Card info") hides every row that changes
 * something or leaves the session (spec §8.4).
 */
export function cardSheetSections(card: Card, opts: { readOnly?: boolean; practiceCount: number }): CardSheetSections {
  const edit = !opts.readOnly;
  return {
    edit,
    reset: edit && (card.reps > 0 || card.knownAt != null),
    reschedule: edit ? (canReschedule(card) ? 'offer' : 'notStudied') : null,
    practice: edit && opts.practiceCount > 0,
    tagsTappable: edit,
    info: !edit,
  };
}

/** One row of the read-only "Card info". */
export interface InfoRow {
  label: string;
  value: string;
  /** A small line under the value that explains it (only the Lapses row has one, see lapsesNote). */
  note?: string;
}

/**
 * The note under "Lapses" when it does not agree with the lapses of the
 * History line in the same sheet. The two numbers count different things:
 *   - "Lapses" (`card.lapses`) is the scheduler's count. It also holds the
 *     lapses imported from Anki and the ones from before the review history
 *     existed, and "Reset progress…" sets it back to 0;
 *   - the History line counts only the lapses in the review history saved
 *     in Maranki (revlogLapseCount).
 * So the note says which way the numbers differ, and why:
 *   Lapses 5, History "1 lapse" → LAPSES_MORE_NOTE
 *   Lapses 0, History "1 lapse" → LAPSES_FEWER_NOTE (after a reset)
 *   the same number, or no History line → no note (null)
 */
export const LAPSES_MORE_NOTE = 'Includes lapses the History below does not show, for example from Anki';
export const LAPSES_FEWER_NOTE = 'Counted since the last reset. The History below also has older reviews';

export function lapsesNote(cardLapses: number, historyLapses: number | null): string | null {
  if (historyLapses === null || !Number.isFinite(cardLapses) || !Number.isFinite(historyLapses)) return null;
  if (cardLapses > historyLapses) return LAPSES_MORE_NOTE;
  if (cardLapses < historyLapses) return LAPSES_FEWER_NOTE;
  return null;
}

/**
 * The read-only details (spec §6.5 "Card info"): card type, direction,
 * repetitions, lapses, ease. The direction reads "German → English" when
 * both sides have a language, else the template's name.
 *
 * `historyLapses` is the lapse count of the History line shown in the same
 * sheet (historyLapsesOf), or null when there is no such count. When it
 * differs from `card.lapses`, the Lapses row gets a note (lapsesNote), so
 * the learner does not see two numbers with the same name that disagree
 * without a reason.
 */
export function infoRows(source: CardSheetSource, historyLapses: number | null = null): InfoRow[] {
  const { card, type, deck } = source;
  const rows: InfoRow[] = [{ label: 'Card type', value: type ? type.name : 'Unknown' }];
  if (type) {
    const typeById = new Map([[type.id, type]]);
    const withDecks = deck
      ? { decks: new Map([[deck.id, deck]]), decksByType: new Map([[type.id, [deck.id]]]) }
      : undefined;
    rows.push({ label: 'Direction', value: directionLabel(card.ord, [type.id], typeById, withDecks) });
  }
  rows.push({ label: 'Repetitions', value: num(card.reps) });
  const note = lapsesNote(card.lapses, historyLapses);
  rows.push(note ? { label: 'Lapses', value: num(card.lapses), note } : { label: 'Lapses', value: num(card.lapses) });
  rows.push({ label: 'Ease', value: Number.isFinite(card.ease) ? `${Math.round(card.ease * 100)}%` : '—' });
  return rows;
}

/** A count as text, '—' when it is not a number. */
function num(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString('en-US') : '—';
}

/* ------------------------------------------------------------ history line */

/**
 * Is this history row a LAPSE (a card you had learned, then forgot)?
 *
 * The lapses are counted from the history rows only (never `card.lapses`,
 * which also holds Anki's count), so the line's "7 reviews · 1 lapse" are
 * two numbers about the SAME history. A row does not store the card's
 * learning step, so the rule reads the interval and the ease, which a
 * lapse changes and a step in Learning does not (srs.ts):
 *   - a missed Check (Again or Hard) of a card that was studied before
 *     (the reducer counts it as a lapse too);
 *   - Again on a card with an interval, when the interval was cut, or the
 *     ease went down since the row before.
 * Again in Learning or Relearning keeps the interval and the ease, so it is
 * not a lapse. An imported card can be in Relearning with an interval
 * (Anki type 3 → stepIndex 0, intervalDays = its interval, ankiSrs.ts).
 *
 * Two cases cannot be told apart, so they are NOT counted:
 *   - a 1-day card at the lowest ease (a lapse keeps 1 day and the ease);
 *   - the FIRST row we have, when the interval stayed the same: it is
 *     Again in Relearning (no lapse) or a lapse of a 1-day card, and with
 *     no row before it we do not know the ease before. (With the lapse
 *     multiplier 0.5, a real lapse of a card with 2 days or more always
 *     cuts the interval, so that case is found by the first rule.)
 */
function isLapse(row: RevlogRow, before: RevlogRow | null): boolean {
  const hasInterval = Number.isFinite(row.ivlBefore) && row.ivlBefore > 0;
  if (row.bucket === 'check') {
    return (row.rating === 'again' || row.rating === 'hard') && (hasInterval || before !== null);
  }
  if (row.bucket !== 'review' || row.rating !== 'again' || !hasInterval) return false;
  if (row.ivlAfter < row.ivlBefore) return true;
  // The interval stayed: a lapse only when the ease went down since the row before.
  return before !== null && row.easeAfter < before.easeAfter;
}

/** How many lapses one card's history rows hold (see isLapse). The rows may come in any order. */
export function revlogLapseCount(rows: readonly RevlogRow[]): number {
  const sorted = [...rows].sort((a, b) => a.seq - b.seq);
  let lapses = 0;
  let before: RevlogRow | null = null;
  for (const row of sorted) {
    if (isLapse(row, before)) lapses += 1;
    before = row;
  }
  return lapses;
}

/**
 * The History line (spec §8.4), from the card's history rows, or null when
 * the sheet shows no History line:
 *   rows                          → "History: 7 reviews · 1 lapse · last: 3 days ago (Good)"
 *   no rows, never studied        → "History: no reviews in Maranki yet"
 *   no rows, but studied (reps>0) → null
 *
 * Why null for a studied card without rows: the review history (revlog)
 * exists only since the note model (wave 3), and an upgrade kept only the
 * last 400 ratings. So a card studied in Maranki before that has
 * repetitions but no rows, and "no reviews in Maranki yet" would be false.
 * (history.ts `cardHistoryLine` has the same rule: no rows → no line.)
 */
export function historyLineOf(rows: readonly RevlogRow[], card: Pick<Card, 'reps'>, now: number): string | null {
  if (rows.length === 0) return card.reps > 0 ? null : CARD_SHEET_COPY.noHistory;
  const summary = summarizeCardHistory(rows);
  return cardHistoryLine({ ...summary, lapses: revlogLapseCount(rows) }, now);
}

/**
 * The lapse count that the History line shows ("· 1 lapse ·"), or null when
 * the line shows no count: the history is not read yet (null), or it has no
 * rows (then the line is "no reviews in Maranki yet", or there is no line).
 * It is the number infoRows compares with `card.lapses`.
 */
export function historyLapsesOf(rows: readonly RevlogRow[] | null): number | null {
  if (!rows || rows.length === 0) return null;
  return revlogLapseCount(rows);
}

/* ------------------------------------------------------------ the other rows */

/** The sub line of "Delete card…": it deletes every direction (the same words as the card editor). */
export function deleteRowSub(siblings: number): string {
  if (siblings === 2) return 'Deletes both directions and their progress';
  if (siblings > 2) return `Deletes all ${siblings} directions and their progress`;
  return 'Its study progress goes with it';
}

/** The delete question's text: "“die Reise” and its study progress will be removed. This deletes both directions of it." */
export function deleteConfirmBody(label: string, siblings: number): string {
  const base = `“${label}” and its study progress will be removed.`;
  if (siblings === 2) return `${base} This deletes both directions of it.`;
  if (siblings > 2) return `${base} This deletes all ${siblings} directions of it.`;
  return base;
}

/** The snackbar after a delete: "“die Reise” deleted". */
export function deleteSnack(label: string): string {
  return `“${label}” deleted`;
}

/** The snackbar after "Reset progress…". */
export const RESET_SNACK = 'Reset to New';

/**
 * Where the sheet's own snackbar sits: this many points below the TOP edge
 * of the sheet's panel (over the drag handle and the card's text). Never at
 * the bottom: there it covered "Delete card…", and a late tap on Undo
 * opened "Delete this card?" (walkthrough M5).
 */
export const SHEET_SNACK_TOP = 8;

/** The snackbar after "Move to deck…": "Moved to Spanish", or "Both directions moved to Spanish". */
export function moveSnack(deckName: string, siblings: number): string {
  if (siblings === 2) return `Both directions moved to ${deckName}`;
  if (siblings > 2) return `All ${siblings} directions moved to ${deckName}`;
  return `Moved to ${deckName}`;
}

/** The route of "Edit card": the card editor for the card's note (all its directions). */
export function editCardRoute(noteId: Id) {
  return { pathname: '/card-editor' as const, params: { noteId } };
}

/**
 * The route of "Practice this card": a practice session (writes nothing,
 * spec §6.6) over a selection token (src/store/selectionRegistry.ts) —
 * card ids are never put in a URL.
 */
export function practiceRoute(selToken: string, label: string) {
  return { pathname: '/session' as const, params: { kind: 'practice', sel: selToken, label } };
}
