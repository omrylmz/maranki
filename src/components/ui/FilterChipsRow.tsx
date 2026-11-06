/**
 * FilterChipsRow — the applied filters as one row of removable chips that
 * scrolls sideways, with "+ Filter" at the end (spec §8.3 Library):
 *
 *   (Deck: German ×) (Level: B1, B2 ×) (Not started ×) (+ Filter)
 *
 * Built from the kit's Chip (spec §8.13 "FilterChipsRow (Chip + dismiss)").
 * The screen owns the Query; this row only shows chips and reports taps:
 *   chip.onPress   tap on the chip (for example: open the Filters sheet at
 *                  that group); optional;
 *   chip.onRemove  tap on its × — the chip's own target, read "Remove filter
 *                  Level: B1, B2" (spec §8.12);
 *   onAdd          tap on "+ Filter" (opens the Filters sheet).
 *
 * The row adds 6 pt of space above and below the chips: a chip's touch
 * target is taller than the chip (44 pt), and a scroll view does not pass
 * on touches outside its own frame.
 *
 * Walkthrough M2 (two fixes):
 *   - A NEW or CHANGED chip scrolls into view. The row could stay scrolled to
 *     the right after picking "Level: B1, B2", so only "+ Filter" was visible
 *     and the new chip was off screen. When the chips change, the row finds
 *     the first chip that is new or has a new label (changedChipKey) and
 *     scrolls just far enough to show all of it (scrollToShow). Every new
 *     version of the row REPLACES the chip that waits to be shown (wave 5c):
 *     a change that only removes chips clears it. Before, a chip whose label
 *     changed without a new size kept waiting, and a later, unrelated change
 *     that moved it scrolled the row by itself. The chip waits until its
 *     text is FINAL (measured, step 1 below, or the whole label): its first
 *     frame shows the character guess, and when the measured text is wider,
 *     the chip grows; its next onLayout scrolls again, so its end and
 *     "+ Filter" do not stay off screen (review round 1). When the measured
 *     text has the SAME size, no onLayout comes: the wait then ends one frame
 *     after the final text is drawn (wave 5d), so the chip never scrolls the
 *     row by itself later (a new row width, a new font size).
 *   - A very long chip ("Deck: German — Everyday, German — Conversation,
 *     German") is cut with "…", so one chip can never fill the row. A screen
 *     reader still says the whole label. The limit is a real WIDTH (wave 5c):
 *     a chip is at most chipMaxWidth, 85 % of the row's visible width, so a
 *     part of the next chip always shows. How much text fits is decided by
 *     the phone's own text layout, not by counting characters:
 *       1. Each chip has a hidden copy of its label, drawn in the chip font
 *          in a box exactly as wide as the text may be (chipTextRoom: the
 *          max width minus the chip's padding and ×, and room for "…").
 *          Its onTextLayout gives the lines the phone broke the label into:
 *          one line = the label fits; more = the first line is the longest
 *          start that fits, cut at a word boundary (textFromLines). So 40
 *          narrow letters on a wide phone stay whole, and 20 wide capitals
 *          ("Deck: WWW…") or Chinese are cut where they really stop fitting.
 *          One exception: a word wider than the rest of the first line moves
 *          WHOLE to the next line. When that leaves only the group name on
 *          the first line ("Deck: "), or the word is wider than a whole line,
 *          the text is cut INSIDE the word instead, as long as one line
 *          holds ("Deck: German_Complete…", not "Deck…").
 *       2. Until that answer arrives (the first frame), the chip shows a
 *          guess by characters (chipTextMax: 32 at the normal font size, 25
 *          at 1.3×, 16 at 2×; chipText).
 *       3. A safety net: a chip that is still drawn wider than the limit
 *          (onLayout) gets fewer characters (fitChipChars: its text shrunk
 *          by the same ratio) and is drawn again, until it fits (at least
 *          CHIP_TEXT_MIN characters).
 *     A new label, font size or row width starts again from step 1.
 *     (The kit's Chip draws its text without a line limit, so the row cuts
 *     the text itself instead of a `maxWidth` with an ellipsis.)
 */
import React, { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleProp, Text, useWindowDimensions, View, ViewStyle } from 'react-native';

import { font } from '@/theme/tokens';

import { Chip } from './badges';
import { A11Y_HIDDEN } from './buttons';

/** One applied filter. */
export interface FilterChipItem {
  /** Stable React key, e.g. the facet key ('deck', 'field:level'). */
  key: string;
  /** The chip text, e.g. "Level: B1, B2". */
  label: string;
  /** The × was tapped: remove this filter. */
  onRemove: () => void;
  /** The chip itself was tapped (optional). */
  onPress?: () => void;
}

/** The text of the add chip, and what a screen reader says for it. */
export const ADD_FILTER_COPY = { text: 'Filter', label: 'Add a filter' } as const;

/** The longest chip text, in characters, at the normal font size (a chip of about 290 pt: it never fills the row). */
export const CHIP_TEXT_MAX = 32;

/** The fewest characters a chip shows, at the largest font sizes ("Level: B1" still fits). */
export const CHIP_TEXT_MIN = 10;

/** The widest a chip may be: this part of the row's visible width (between the two insets). */
export const CHIP_MAX_WIDTH_FRAC = 0.85;

/**
 * The width of a filter chip that is not its text, in pt: the Chip's 14 pt
 * padding before the text, and its × target (6 + 13 + 14 pt). This part does
 * not grow with the font size.
 */
export const CHIP_CHROME = 47;

/**
 * The room a "…" needs after a cut text, in pt at the normal font size (the
 * "…" of the chip font, Hanken Grotesk 700 at 13.5 pt, is about 9.3 pt). It
 * grows with the font size, like the text.
 */
export const ELLIPSIS_ROOM = 10;

/**
 * The widest a chip may be, in pt: CHIP_MAX_WIDTH_FRAC of the row's visible
 * width (the row minus the inset on each side).
 *
 *   chipMaxWidth(320, 20)   // 238 (a 320 pt phone, the Library's 20 pt inset)
 */
export function chipMaxWidth(rowWidth: number, inset: number): number {
  return Math.max(0, (rowWidth - 2 * inset) * CHIP_MAX_WIDTH_FRAC);
}

/**
 * How wide the TEXT of a chip may be, in pt (step 1 in the header): the
 * chip's max width (chipMaxWidth) minus its padding and × (CHIP_CHROME) and
 * the room for a "…" at this font size. The hidden copy of the label is
 * drawn in a box this wide.
 *
 *   chipTextRoom(238, 1)     // 181 (238 − 47 − 10)
 *   chipTextRoom(238, 2)     // 171 (the "…" is twice as wide)
 */
export function chipTextRoom(maxWidth: number, fontScale: number): number {
  const scale = Number.isFinite(fontScale) && fontScale > 0 ? fontScale : 1;
  return Math.max(0, Math.floor(maxWidth - CHIP_CHROME - ELLIPSIS_ROOM * scale));
}

/** Trailing commas, dashes and spaces: dropped before a "…". */
const CUT_END = /[\s,;:·›—–-]+$/;

/** The last character of a line that ends INSIDE a word (not a space, comma, dash …). */
const WORD_END = /[^\s,;:·›—–-]$/;

/**
 * Where the value of a chip label starts: after "Group: " ("Deck: German" → 6),
 * or 0 for a label without a group ("Not started").
 */
function valueStart(label: string): number {
  const at = label.indexOf(': ');
  return at < 0 ? 0 : at + 2;
}

/**
 * The cut INSIDE a word when the phone moved a long word whole to the next
 * line (the exception in step 1 of the header), or null when it does not
 * apply. It applies when the second line follows the first exactly and
 *   - the first line holds only the group name ("Deck: "): without the cut
 *     the chip would show "Deck…", with no value at all; or
 *   - the second line ends INSIDE a word: that word is wider than a whole
 *     line, so the phone broke it by characters.
 * The second line is one line of the label's own characters, so about that
 * many characters fit in one line: the label is cut there, inside the word,
 * with "…" (the room of chipTextRoom keeps space for it). The onLayout
 * safety net (step 3) still shrinks a chip that comes out too wide.
 */
function cutInsideWord(label: string, lines: readonly { text: string }[], head: string): string | null {
  const first = lines[0].text;
  const second = lines[1].text;
  const end = first.length + second.length;
  if (second === '' || !label.startsWith(first) || label.slice(first.length, end) !== second) return null;
  const noValue = head.length <= valueStart(label);
  const brokenWord = end < label.length && WORD_END.test(second) && !/^\s/.test(label.slice(end));
  if (!noValue && !brokenWord) return null;
  const chars = Array.from(label);
  const fit = Math.min(Array.from(second.trimEnd()).length, chars.length - 1);
  return chars.slice(0, fit).join('').replace(CUT_END, '');
}

/**
 * The chip text from the phone's own text layout (step 1 in the header).
 * `lines` are the lines the WHOLE label was broken into in a box
 * chipTextRoom wide (onTextLayout of the hidden copy):
 *   - one line (or none): the label fits — the label;
 *   - more: the first line is the longest start that fits (the phone breaks
 *     at a word boundary, or inside a word longer than the line) — that
 *     start with "…". The room of chipTextRoom keeps space for the "…".
 *   - except when the phone moved a long word whole to the second line and
 *     that leaves only the group name on the first line, or the word is
 *     longer than a whole line (cutInsideWord): then the cut is inside the
 *     word, when that shows more of the label.
 * A first line that is not the start of the label (it should never happen)
 * or that is only separators falls back to the character cut (chipText).
 *
 *   textFromLines('Level: B1, B2', [{ text: 'Level: B1, B2' }])
 *     → 'Level: B1, B2'
 *   textFromLines('Deck: German — Everyday, German — Conversation, German',
 *                 [{ text: 'Deck: German — Everyday, German — ' }, { text: 'Conversation, German' }])
 *     → 'Deck: German — Everyday, German…'
 *   textFromLines('Deck: German_Complete_Vocabulary',
 *                 [{ text: 'Deck: ' }, { text: 'German_Complete_Vocab' }, { text: 'ulary' }])
 *     → 'Deck: German_Complete…'   (not 'Deck…')
 */
export function textFromLines(label: string, lines: readonly { text: string }[]): string {
  if (lines.length <= 1) return label;
  const first = lines[0].text;
  const head = first.replace(CUT_END, '');
  const inside = cutInsideWord(label, lines, head);
  if (inside !== null && inside.length > head.length) return `${inside}…`;
  if (head === '' || !label.startsWith(head)) return chipText(label, CHIP_TEXT_MIN);
  return head.length >= label.length ? label : `${head}…`;
}

/** What the hidden copy of a chip's label measured: the text that fits `room` (textFromLines). */
interface ChipMeasure {
  label: string;
  room: number;
  text: string;
}

/**
 * A chip is drawn `width` pt wide with `shown` characters of text, but may
 * be at most `max` pt wide. Returns how many characters to show instead:
 * the text part (the width without CHIP_CHROME) shrunk by the same ratio,
 * always fewer than now and at least CHIP_TEXT_MIN. Returns null when the
 * chip fits, or when it shows CHIP_TEXT_MIN characters already.
 *
 *   fitChipChars(31, 400, 238)   // 16  (31 × 191 / 353)
 *   fitChipChars(31, 230, 238)   // null (it fits)
 */
export function fitChipChars(shown: number, width: number, max: number): number | null {
  if (!(width > max) || shown <= CHIP_TEXT_MIN) return null;
  const text = width - CHIP_CHROME;
  const room = Math.max(0, max - CHIP_CHROME);
  const chars = text > 0 ? Math.floor((shown * room) / text) : CHIP_TEXT_MIN;
  return Math.max(CHIP_TEXT_MIN, Math.min(chars, shown - 1));
}

/**
 * The character limit the safety net found for one chip (step 3,
 * fitChipChars). It holds only for the label, the width limit and the font
 * size it was found for, and only for the text it cut: the guess (`measured`
 * false) or the measured text (`measured` true). So a measurement that
 * arrives after a cut of the guess is still used.
 */
interface ChipFit {
  label: string;
  maxWidth: number;
  base: number;
  chars: number;
  measured: boolean;
}

/** The measurement of a chip when it holds for this label and room, else undefined. */
function measureFor(measure: ChipMeasure | undefined, label: string, room: number): ChipMeasure | undefined {
  return measure && measure.label === label && measure.room === room ? measure : undefined;
}

/** The safety net's character limit when it still holds (see ChipFit), else null. */
function limitOf(fit: ChipFit | undefined, label: string, maxWidth: number, base: number, measured: boolean): number | null {
  return fit && fit.label === label && fit.maxWidth === maxWidth && fit.base === base && fit.measured === measured
    ? fit.chars
    : null;
}

/**
 * The text a chip shows (the three steps of the header): the safety net's
 * cut when the chip was drawn too wide, else the text the phone's layout
 * measured for this label and room, else the guess by characters.
 */
function shownText(label: string, measure: ChipMeasure | undefined, limit: number | null, guess: number): string {
  if (limit !== null) return chipText(label, limit);
  if (measure) return measure.text;
  return chipText(label, guess);
}

/**
 * The longest chip text for the phone's font size (`fontScale` from
 * useWindowDimensions; walkthrough M2 "max width"). The chip text is drawn
 * `fontScale` times bigger, so CHIP_TEXT_MAX / fontScale characters keep the
 * chip about as wide as at the normal size. A font smaller than normal keeps
 * CHIP_TEXT_MAX; at least CHIP_TEXT_MIN.
 *
 *   chipTextMax(1)     // 32
 *   chipTextMax(1.3)   // 25
 *   chipTextMax(2)     // 16
 *   chipTextMax(3.1)   // 10 (CHIP_TEXT_MIN)
 */
export function chipTextMax(fontScale: number): number {
  const scale = Number.isFinite(fontScale) && fontScale > 1 ? fontScale : 1;
  return Math.max(CHIP_TEXT_MIN, Math.round(CHIP_TEXT_MAX / scale));
}

/**
 * The chip text shown in the row: the label, or — when it is longer than
 * `max` characters — its start, cut at a word boundary, with "…". A single
 * very long word is cut inside the word. Trailing commas, dashes and spaces
 * before the "…" are dropped.
 *
 *   chipText('Level: B1, B2')                                               → 'Level: B1, B2'
 *   chipText('Deck: German — Everyday, German — Conversation, German')     → 'Deck: German — Everyday, German…'
 */
export function chipText(label: string, max: number = CHIP_TEXT_MAX): string {
  const chars = Array.from(label);
  if (chars.length <= max) return label;
  // Room for the "…": at most max - 1 characters of the label.
  const head = chars.slice(0, max - 1).join('');
  const wordEnds = chars[max - 1] === ' ';
  const space = head.lastIndexOf(' ');
  const cut = wordEnds || space < Math.floor(max / 2) ? head : head.slice(0, space);
  return `${cut.replace(CUT_END, '')}…`;
}

/** A chip as the row compares it (its key and its text). */
export interface ChipMark {
  key: string;
  label: string;
}

/**
 * The chip to bring into view after the chips changed: the first one that is
 * NEW or whose label CHANGED ("Level: B1" → "Level: B1, B2"). null when only
 * chips were removed (nothing new to show) or nothing changed.
 *
 *   changedChipKey([{ key: 'deck', … }], [{ key: 'deck', … }, { key: 'field:level', … }])   // 'field:level'
 */
export function changedChipKey(prev: readonly ChipMark[], next: readonly ChipMark[]): string | null {
  const before = new Map(prev.map((chip) => [chip.key, chip.label]));
  for (const chip of next) {
    if (before.get(chip.key) !== chip.label) return chip.key;
  }
  return null;
}

/**
 * Where to scroll so the chip at `chip.x` (width `chip.width`) is fully in
 * view, keeping `inset` of space at the edge; null when it is in view
 * already. Minimal: a chip on the right is lined up with the right edge; a
 * chip on the left (or one wider than the row) with the left edge.
 * `view.width` 0 means "not measured yet": the chip goes to the left edge.
 *
 *   scrollToShow({ x: 500, width: 120 }, { offset: 0, width: 360 }, 20)   // 280
 *   scrollToShow({ x: 40, width: 120 }, { offset: 0, width: 360 }, 20)    // null
 */
export function scrollToShow(
  chip: { x: number; width: number },
  view: { offset: number; width: number },
  inset: number,
): number | null {
  const left = Math.max(0, chip.x - inset);
  if (view.width <= 0) return left;
  const right = chip.x + chip.width + inset - view.width;
  if (left < view.offset) return left;
  if (chip.x + chip.width + inset > view.offset + view.width) return Math.max(0, Math.min(left, right));
  return null;
}

interface FilterChipsRowProps {
  chips: readonly FilterChipItem[];
  /** Shows "+ Filter" at the end when set. */
  onAdd?: () => void;
  /** Space before the first chip and after the last (the screen's side padding). Default 0. */
  inset?: number;
  style?: StyleProp<ViewStyle>;
}

/** The chips' key + text in one string: a change of either is a new "version" of the row. */
function signatureOf(chips: readonly ChipMark[]): string {
  return chips.map((chip) => `${chip.key}\u001f${chip.label}`).join('\u001e');
}

/**
 * The 6 pt a chip's touch area reaches above and below the pill (Chip's own
 * slop). The wrapper that measures a chip covers the same area, so a tap
 * there still reaches the chip.
 */
const CHIP_SLOP = 6;

/** The row's refs: the scroll view, where each chip is, and what part of the row is in view. */
interface RowParts {
  scroll: React.RefObject<ScrollView | null>;
  boxes: React.RefObject<Map<string, { x: number; width: number }> | null>;
  view: React.RefObject<{ offset: number; width: number }>;
}

/**
 * Run `fn` after the NEXT frame is drawn (two animation frames: the frame
 * now, then the next one). Returns the function that cancels it (an
 * effect's clean-up). Effects only.
 */
function afterNextFrame(fn: () => void): () => void {
  let second: number | null = null;
  const first = requestAnimationFrame(() => {
    second = requestAnimationFrame(fn);
  });
  return () => {
    cancelAnimationFrame(first);
    if (second !== null) cancelAnimationFrame(second);
  };
}

/** Scroll so the chip `key` is in view, when its place is known (event handlers and effects only). */
function showChip(parts: RowParts, key: string, inset: number): void {
  const box = parts.boxes.current?.get(key);
  if (!box) return;
  const x = scrollToShow(box, parts.view.current, inset);
  if (x === null) return;
  parts.scroll.current?.scrollTo({ x, animated: true });
  parts.view.current.offset = x;
}

export function FilterChipsRow({ chips, onAdd, inset = 0, style }: FilterChipsRowProps) {
  // Fewer characters at a bigger font size: the chip's width stays the same.
  const { fontScale, width: winW } = useWindowDimensions();
  const textMax = chipTextMax(fontScale);
  // The real width limit (limit 2 in the header): the row's measured width,
  // the window's until it is measured (the Library's row spans the window).
  const [rowW, setRowW] = useState(0);
  const maxW = chipMaxWidth(rowW > 0 ? rowW : winW, inset);
  // The width the chip TEXT may have (step 1): the hidden copies of the labels are drawn this wide.
  const room = chipTextRoom(maxW, fontScale);
  // Per chip key: the text the phone's layout measured for its label (step 1, textFromLines).
  const [measures, setMeasures] = useState<ReadonlyMap<string, ChipMeasure>>(() => new Map());
  // Per chip key: the safety net's character limit (step 3, fitChipChars).
  const [fits, setFits] = useState<ReadonlyMap<string, ChipFit>>(() => new Map());
  const scrollRef = useRef<ScrollView>(null);
  // Where each chip is in the row, and what part of the row is in view (event handlers write them).
  const boxes = useRef<Map<string, { x: number; width: number }> | null>(null);
  const view = useRef({ offset: 0, width: 0 });
  // The chip waiting to be shown until its new place AND its final text are measured.
  const pending = useRef<string | null>(null);

  // A change of the chips is noticed DURING render ("adjust state when a
  // prop changes", no effect for it): `focus` is the chip to show.
  const marks = chips.map((chip) => ({ key: chip.key, label: chip.label }));
  const signature = signatureOf(marks);
  const [seen, setSeen] = useState({ signature, marks, focus: null as string | null, version: 0 });
  if (seen.signature !== signature) {
    setSeen({ signature, marks, focus: changedChipKey(seen.marks, marks), version: seen.version + 1 });
  }

  const parts: RowParts = { scroll: scrollRef, boxes, view };

  // After the new chips are drawn: show the changed chip. Its place may still
  // be the old one; its onLayout (below) scrolls again with the new place.
  // EVERY new version replaces the waiting chip, also with null (a change
  // that only removed chips): a chip whose label changed without a new size
  // gets no onLayout, and must not wait for a later, unrelated move (wave 5c).
  const { focus, version } = seen;
  useEffect(() => {
    pending.current = focus;
    if (focus === null) return;
    showChip({ scroll: scrollRef, boxes, view }, focus, inset);
  }, [focus, version, inset]);

  // The waiting chip now shows its FINAL text (its measurement arrived, step
  // 1). When that text has a new size, its onLayout comes with this layout
  // and scrolls once more (review round 1). When the size did NOT change, no
  // onLayout comes at all: the chip would wait for ever, and a later,
  // unrelated move of it (a new row width, a new font size, the learner
  // scrolled away) would scroll the row by itself. So the wait ends after
  // the next frame (wave 5d): an onLayout of this layout has come by then.
  const marksNow = seen.marks;
  useEffect(() => {
    const key = pending.current;
    if (key === null) return;
    const mark = marksNow.find((m) => m.key === key);
    if (!mark || !measureFor(measures.get(key), mark.label, room)) return;
    return afterNextFrame(() => {
      if (pending.current === key) pending.current = null;
    });
  }, [measures, marksNow, room]);

  if (chips.length === 0 && !onAdd) return null;
  return (
    <ScrollView
      ref={scrollRef}
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      scrollEventThrottle={32}
      onScroll={(e) => {
        view.current.offset = e.nativeEvent.contentOffset.x;
      }}
      onLayout={(e) => {
        const { width } = e.nativeEvent.layout;
        view.current.width = width;
        if (width !== rowW) setRowW(width);
      }}
      style={[{ flexGrow: 0 }, style]}
      contentContainerStyle={{ gap: 8, paddingVertical: 6, paddingHorizontal: inset, alignItems: 'center' }}
    >
      {chips.map((chip) => {
        const measure = measureFor(measures.get(chip.key), chip.label, room);
        const limit = limitOf(fits.get(chip.key), chip.label, maxW, textMax, measure !== undefined);
        const text = shownText(chip.label, measure, limit, textMax);
        return (
          <View
            key={chip.key}
            // The same outer size as the chip alone (the negative margin), but
            // its frame covers the chip's whole touch area (the padding).
            style={{ marginVertical: -CHIP_SLOP, paddingVertical: CHIP_SLOP }}
            onLayout={(e) => {
              const { x, width } = e.nativeEvent.layout;
              (boxes.current ??= new Map()).set(chip.key, { x, width });
              // Still wider than the row allows: fewer characters, drawn again (step 3).
              const chars = fitChipChars(Array.from(text).length, width, maxW);
              if (chars !== null) {
                const fit: ChipFit = { label: chip.label, maxWidth: maxW, base: textMax, chars, measured: measure !== undefined };
                setFits((prev) => new Map(prev).set(chip.key, fit));
              }
              if (pending.current === chip.key) {
                // Keep waiting while the chip shows only the character guess:
                // the measured text can be WIDER, and then this chip's next
                // onLayout must scroll again (review round 1). The whole
                // label is final too (a measurement can only make it narrower).
                if (measure !== undefined || text === chip.label) pending.current = null;
                showChip(parts, chip.key, inset);
              }
            }}
          >
            <Chip active dismiss label={chip.label} onPress={chip.onPress} onDismiss={chip.onRemove}>
              {text}
            </Chip>
          </View>
        );
      })}
      {onAdd ? (
        <Chip icon="add" label={ADD_FILTER_COPY.label} onPress={onAdd}>
          {ADD_FILTER_COPY.text}
        </Chip>
      ) : null}
      {/* Step 1: the hidden copy of each label, in the chip font (badges.tsx
          Chip: sans 700, 13.5 pt), in a box `room` wide. The phone's own text
          layout says how much of the label fits (onTextLayout). Drawn only
          until it has answered for this label and room. */}
      {chips.map((chip) =>
        measureFor(measures.get(chip.key), chip.label, room) ? null : (
          <View
            key={`measure:${chip.key}`}
            {...A11Y_HIDDEN}
            pointerEvents="none"
            style={{ position: 'absolute', left: 0, top: 0, width: room, opacity: 0 }}
          >
            <Text
              style={[font('sans', 700), { fontSize: 13.5 }]}
              onTextLayout={(e) => {
                const text = textFromLines(chip.label, e.nativeEvent.lines);
                const measured: ChipMeasure = { label: chip.label, room, text };
                setMeasures((prev) => {
                  const old = prev.get(chip.key);
                  if (old && old.label === measured.label && old.room === measured.room && old.text === text) return prev;
                  return new Map(prev).set(chip.key, measured);
                });
              }}
            >
              {chip.label}
            </Text>
          </View>
        ),
      )}
    </ScrollView>
  );
}
