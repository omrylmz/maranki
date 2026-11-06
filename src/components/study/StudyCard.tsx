/**
 * StudyCard — the card of a study session (spec §6.2). It draws a CardFace
 * (from useFaces(), render.ts): blocks of fields, each styled by its ROLE.
 *
 *   ┌──────────────────────────────────────────┐
 *   │ (B1) (noun) (step 1/2) (hint)        🔊  │  ← top row: its OWN row, it wraps; never over the text
 *   │                                          │
 *   │               die Stunde                 │  ← the question headline
 *   │            NOTE  Some text               │  ← other question fields (sans, ink3, with label)
 *   │          [typing field / quiz / hint]    │  ← `questionExtra` (the session's mode)
 *   │            ✋ Tap to reveal               │
 *   │░░░░░░░░░░░ paper fade when more below ░░░│
 *   └──────────────────────────────────────────┘
 *
 * Answer side: the question again (small), the mode's result (`answerExtra`),
 * a hairline, the answer headline, then the other answer fields by role:
 * example serif italic, example meaning small, pronunciation mono, detail
 * fields as labelled rows (FieldRows), images full width.
 *
 * Rules from the device findings (wave 3 emulator run):
 *   - The headline size depends on its LENGTH, on both sides
 *     (sessionLogic headlineSize): short → the big serif; 40–120 characters
 *     or a few lines → a smaller serif; longer (a long Anki back in HTML) →
 *     normal-weight sans, left-aligned. Never the big size for a long text,
 *     and never bold (bold only where the field's HTML says <b>).
 *   - The card body is a ScrollView, at most `maxHeight` tall (the screen
 *     minus the header and the rating zone), with a soft paper fade at the
 *     bottom while more content is below. Long Anki backs can scroll.
 *     The ScrollView passes taps to its buttons while the keyboard is open
 *     (`keyboardShouldPersistTaps="handled"`): ONE tap on "Check" checks.
 *   - Badges sit in their own row at the top (they wrap), never over text.
 *   - Images (`<img>` in a field) are drawn with expo-image from the deck's
 *     media folder (`Paths.document/media/<deckId>/<name>`, platform/media.ts
 *     mediaFileUri), full width; a tap shows the image full screen (the
 *     shared ImageViewer, src/components/ui/ImageViewer.tsx: the CardSheet
 *     opens the same one, wave 5i). expo-image draws SVG too (SDK 56 docs). A missing file or an image that cannot be
 *     drawn shows a quiet placeholder with its file name — never a crash.
 *   - Every picture sits on the image well (`c.imageWell`): light in BOTH
 *     themes, on the card and full screen. WHY (wave 5g, Evening): many
 *     imported pictures are black line art on a transparent background, and
 *     on the dark Evening well their lines and a black "?" could not be seen.
 *     The placeholder of a missing picture keeps its quiet paperSunk look.
 *   - Sound tokens are not drawn: audio is not imported yet (spec §7 #63).
 *
 * A German term (role 'term', language German) gets its article in the
 * gender colour (TermText, spec §9.2) when the deck has gender colours on.
 *
 * Accessibility (spec §8.12): the front reads "Card. {question}. Double tap
 * to reveal." (sessionLogic cardA11yLabel). In Typing, Quiz and Articles a
 * tap does not reveal, so the question headline alone is one element
 * "Card. {question}." (Articles: the bare word it shows, `promptLabel`); the
 * typing field, the choices and the hint stay separate elements. The answer
 * side is read element by element: the question, the answer, then each
 * field "Label: value". The front's tap area is a NEW native view after the
 * reveal (a new `key`), with no label and no tap: Android kept the old
 * "Card. … Double tap to reveal." label on the old view (final device pass
 * K1-2). The key follows the label itself (`tapToReveal`), so More › Switch
 * mode (Flashcards → Typing / Quiz / Articles before the reveal) also gets a
 * new view, and so does the question headline when its own label goes
 * (review round 2). That new view is also not native-clickable (focusable={false}) and
 * not "disabled", so TalkBack does not join the answer into one stop and
 * never says "disabled" for it (review round 1). A label never gets a full
 * stop after "?" or "!" (sessionLogic asSentence, K1-3).
 *
 * The screen-reader focus after the reveal (release pass 2026-11-02, C1-5):
 * the view that had the focus is gone (the front tap area, or Typing's
 * "Check" and Quiz's choice, which are drawn on the front). Nothing moved
 * the focus, so TalkBack lost its place. Now, when a screen reader is on,
 * the focus moves to the FIRST element of the answer side (the question
 * line; then the answer and the fields follow in reading order), a moment
 * after the reveal (`focusAfterReveal`). With no screen reader on, nothing
 * happens. Articles draws its own result (`answerOverride`, a polite live
 * region that reads itself), so there the focus is not moved.
 * A question with no text (only a picture) has NO question line on the
 * answer side (sessionLogic answerQuestionLine is ''): an empty `accessible`
 * Text was a silent TalkBack stop, and it took the focus (review of C1-5).
 * Then the focus goes to the first element of the answer headline instead:
 * its first line of text, or its first picture. But in Typing and Quiz the
 * mode's result comes BEFORE the answer headline (the "You typed: …" line,
 * the picked choice), so the focus goes there first (`answerExtraFocus`,
 * wave 5h, C2 review of wave 5g): it skipped them before.
 *
 * Pictures (wave-5b R9): a block with an image is never wrapped into ONE
 * screen-reader element, so each picture stays reachable on its own as a
 * "Picture" button (a double tap opens it full screen). In Typing and Quiz
 * the headline's first line of text then says "Card. {that line}." — only
 * that line's own text (sessionLogic blockHasImage, headlineLineLabel): the
 * later lines read themselves, so no text is read twice. The screen reader
 * reads the headline in the order it is drawn, and "Card." always comes
 * first: when a picture comes before the first line of text, the picture
 * says "Card. Picture." and the text after it reads itself (wave 5c).
 * Flashcards keep their one "Card. … Double tap to reveal." button: there a
 * double tap must reveal.
 *
 * Pure layout: the session decides what is shown (revealed, the mode's
 * extras) and owns every action.
 */
import { Image } from 'expo-image';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Pressable, ScrollView, Text, type TextStyle, View } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import {
  A11Y_HIDDEN,
  FacetBadge,
  FieldLines,
  FieldRows,
  IconBtn,
  inlineStyle,
  Ion,
  Overline,
  Pill,
  type RenderImage,
  RiseIn,
  type RoleText,
  TermText,
  visibleBlocks,
} from '@/components/ui';
import { ImageViewer, OPEN_IMAGE_HINT } from '@/components/ui/ImageViewer';
import { blockHasContent, blockText } from '@/domain/face';
import type { CardFace, FieldBlock, Id, Inline } from '@/domain/model';
import { mediaFileUri } from '@/platform/media';
import { font, tnum } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

import {
  answerQuestionLine,
  blockHasImage,
  cardA11yLabel,
  headlineLineLabel,
  type HeadlineSize,
  headlineSize,
  PICTURE_LABEL,
} from './sessionLogic';

type TextInline = Extract<Inline, { t: 'text' }>;

/** How a headline looks: its font (RoleText) and the line metrics. */
interface HeadStyle {
  base: RoleText;
  lineHeight: number;
  letterSpacing: number;
}

/** The headline look of each side and size (spec §6.2 + the device findings). */
export const HEADLINE_STYLES: Readonly<Record<'prompt' | 'answer', Record<HeadlineSize, HeadStyle>>> = {
  prompt: {
    big: { base: { family: 'serif', weight: 600, italic: false, size: 42, color: 'ink' }, lineHeight: 46, letterSpacing: -0.63 },
    medium: { base: { family: 'serif', weight: 500, italic: false, size: 28, color: 'ink' }, lineHeight: 34, letterSpacing: -0.3 },
    long: { base: { family: 'sans', weight: 400, italic: false, size: 20, color: 'ink' }, lineHeight: 28, letterSpacing: 0 },
  },
  answer: {
    big: { base: { family: 'serif', weight: 600, italic: false, size: 31, color: 'ink' }, lineHeight: 35, letterSpacing: -0.47 },
    medium: { base: { family: 'serif', weight: 500, italic: false, size: 23, color: 'ink' }, lineHeight: 29, letterSpacing: -0.2 },
    long: { base: { family: 'sans', weight: 400, italic: false, size: 16, color: 'ink' }, lineHeight: 23, letterSpacing: 0 },
  },
};

/** What `AccessibilityInfo.sendAccessibilityEvent` can move the focus to: a drawn (host) view, like a Text. */
type FocusTarget = Parameters<typeof AccessibilityInfo.sendAccessibilityEvent>[0];

/**
 * How long after the reveal the screen-reader focus moves (ms). The answer
 * fades in (RiseIn, 220 ms, from opacity 0), and Android does not give the
 * focus to a view it does not count as visible yet. Under Reduce Motion the
 * answer is there at once; the short wait does no harm.
 */
export const REVEAL_FOCUS_DELAY_MS = 300;

/**
 * Move the screen-reader focus to `target()` a moment after the reveal
 * (release pass C1-5) — ONLY when a screen reader is on: it asks
 * `AccessibilityInfo.isScreenReaderEnabled()` first, and does nothing when
 * the answer is false, the call fails, or `target()` is null by then.
 * Returns a function that cancels it (the card went away, or the answer was
 * hidden again before the wait ended). Never throws.
 *
 *   useEffect(() => focusAfterReveal(() => answerFirst.current), [...]);
 *
 * It uses `sendAccessibilityEvent(view, 'focus')`, the API that replaces the
 * old `setAccessibilityFocus(reactTag)` (deprecated in React Native 0.85).
 */
export function focusAfterReveal(target: () => FocusTarget | null, delayMs: number = REVEAL_FOCUS_DELAY_MS): () => void {
  let alive = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const moveFocus = () => {
    timer = null;
    const view = alive ? target() : null;
    if (!view) return;
    try {
      AccessibilityInfo.sendAccessibilityEvent(view, 'focus');
    } catch {
      // No accessibility API here (an old web build): the focus stays where it is.
    }
  };
  try {
    AccessibilityInfo.isScreenReaderEnabled()
      .then((on) => {
        if (alive && on === true) timer = setTimeout(moveFocus, delayMs);
      })
      .catch(() => undefined);
  } catch {
    // No such method here: the screen reader counts as off, so nothing moves.
  }
  return () => {
    alive = false;
    if (timer !== null) clearTimeout(timer);
  };
}

/** A text inline with no style: the base font of a RoleText. */
const PLAIN: TextInline = { t: 'text', text: '' };

/** The file:// address of a deck image, or null (unsafe name, file missing, or no file system). */
function imageUri(deckId: Id, name: string): string | null {
  try {
    return mediaFileUri(deckId, name);
  } catch {
    return null;
  }
}

/**
 * The screen-reader label of a picture. `cardIntro` = it is the FIRST thing
 * of a Typing / Quiz question headline, so it also starts the card: "Card.
 * Picture." (headlineLineLabel, wave 5c R9 read order).
 */
function pictureLabel(text: string, cardIntro: boolean | undefined): string {
  return cardIntro ? headlineLineLabel(text) : text;
}

/** A missing or broken image: its file name, quietly (on paperSunk, not on the image well). */
function ImagePlaceholder({ name, cardIntro, focusRef }: { name: string; cardIntro?: boolean; focusRef?: React.Ref<View> }) {
  const c = useColors();
  return (
    <View
      ref={focusRef}
      accessible
      accessibilityLabel={pictureLabel(`${PICTURE_LABEL} ${name} is not available`, cardIntro)}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        alignSelf: 'stretch',
        marginTop: 8,
        paddingVertical: 10,
        paddingHorizontal: 12,
        borderRadius: 10,
        backgroundColor: c.paperSunk,
      }}
    >
      <View {...A11Y_HIDDEN}>
        <Ion name="image-outline" size={16} color={c.ink3} />
      </View>
      <Text numberOfLines={1} style={[font('mono', 400), { flex: 1, fontSize: 12, color: c.ink3 }]}>
        {name}
      </Text>
    </View>
  );
}

/**
 * One imported image, full width at its own shape, on the image well; a tap shows it full screen.
 * `cardIntro`: the picture is the first thing of a question headline (see pictureLabel).
 * `focusRef`: the screen-reader focus goes to this picture after the reveal (see StudyCard).
 */
function CardImage({
  deckId,
  name,
  onOpen,
  cardIntro,
  focusRef,
}: {
  deckId: Id;
  name: string;
  onOpen: (uri: string) => void;
  cardIntro?: boolean;
  focusRef?: React.Ref<View>;
}) {
  const c = useColors();
  const uri = useMemo(() => imageUri(deckId, name), [deckId, name]);
  const [ratio, setRatio] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  if (!uri || failed) return <ImagePlaceholder name={name} cardIntro={cardIntro} focusRef={focusRef} />;
  return (
    <Pressable
      ref={focusRef}
      onPress={() => onOpen(uri)}
      accessibilityRole="imagebutton"
      accessibilityLabel={pictureLabel(PICTURE_LABEL, cardIntro)}
      accessibilityHint={OPEN_IMAGE_HINT}
      style={{ alignSelf: 'stretch', marginTop: 8 }}
    >
      <Image
        source={{ uri }}
        contentFit="contain"
        onLoad={(event) => {
          const { width, height } = event.source;
          if (width > 0 && height > 0) setRatio(width / height);
        }}
        onError={() => setFailed(true)}
        style={{
          width: '100%',
          aspectRatio: ratio ?? 4 / 3,
          maxHeight: 260,
          borderRadius: 10,
          // Light in both themes: black line art on a transparent picture stays readable (wave 5g).
          backgroundColor: c.imageWell,
        }}
      />
    </Pressable>
  );
}

/** True when a line has text that is more than spaces. */
function lineHasText(line: readonly Inline[]): boolean {
  return line.some((p) => p.t === 'text' && p.text.trim() !== '');
}

/** Lines of a field in a given look (bold / italic / underline from the field's HTML, images after their line). */
function RichLines({
  lines,
  head,
  align,
  renderImage,
  renderIntroImage,
  fitOneLine,
  cardLabel,
  renderFocusImage,
  focusTextRef,
}: {
  lines: readonly (readonly Inline[])[];
  head: HeadStyle;
  align: TextStyle['textAlign'];
  renderImage: RenderImage;
  /** Draws a picture that starts the card ("Card. Picture.", see `cardLabel`). Default: renderImage. */
  renderIntroImage?: RenderImage;
  /**
   * Given = the FIRST thing drawn is the target of the screen-reader focus
   * after the reveal (the answer side has no question line, see StudyCard):
   *   - a line of text gets `focusTextRef` and becomes a screen-reader
   *     element of its own (Android: a focusable view), so the focus can move there;
   *   - a picture that comes BEFORE any text is drawn with this function (it carries the ref).
   */
  renderFocusImage?: RenderImage;
  /** The first line of text, when `renderFocusImage` is given (see there). */
  focusTextRef?: React.Ref<Text>;
  /** A single word: scale it down to fit one line instead of breaking it. */
  fitOneLine?: boolean;
  /**
   * The FIRST thing a screen reader meets carries the card label (a
   * question headline with a picture, sessionLogic headlineLineLabel):
   *   - a line of text: "Card. {that line}.", only that line's own text, so
   *     no text is read twice (review round 2);
   *   - a picture that comes BEFORE any text: "Card. Picture.", and the
   *     first line of text after it reads itself.
   * WHY (wave 5c, R9 read order): the label sat on the first line of TEXT
   * even when a picture came first, so a screen reader said "Picture", then
   * "Card. Was ist das?" — the start of the card came in the middle. Now
   * the elements are read in the order they are drawn, and "Card." comes first.
   */
  cardLabel?: boolean;
}) {
  const c = useColors();
  const { base, lineHeight, letterSpacing } = head;
  // The first line with text or a picture. Its text is drawn before its pictures, so a
  // line with text starts with the text; a line with only pictures starts with its first picture.
  const firstLine = lines.findIndex((line) => lineHasText(line) || line.some((p) => p.t === 'img'));
  const introText = cardLabel && firstLine >= 0 && lineHasText(lines[firstLine]) ? firstLine : -1;
  const introImage = cardLabel && firstLine >= 0 && introText < 0 ? firstLine : -1;
  // The same "first thing" as the focus target after the reveal (only with `renderFocusImage`).
  const focusOn = renderFocusImage !== undefined;
  const focusText = focusOn && firstLine >= 0 && lineHasText(lines[firstLine]) ? firstLine : -1;
  const focusImage = focusOn && firstLine >= 0 && focusText < 0 ? firstLine : -1;
  return (
    <View style={{ alignSelf: 'stretch', gap: 2 }}>
      {lines.map((line, li) => {
        if (line.length === 0) return <View key={li} style={{ height: Math.round(lineHeight * 0.45) }} />;
        const texts = line.filter((p): p is TextInline => p.t === 'text');
        const hasText = texts.some((p) => p.text.trim() !== '');
        // The first picture of the intro line (only when no text comes before it).
        const introAt = li === introImage ? line.findIndex((p) => p.t === 'img') : -1;
        // The first picture of the focus line (only when no text comes before it).
        const focusAt = li === focusImage ? line.findIndex((p) => p.t === 'img') : -1;
        const pictureOf = (pi: number): RenderImage =>
          pi === introAt ? (renderIntroImage ?? renderImage) : pi === focusAt ? (renderFocusImage ?? renderImage) : renderImage;
        return (
          <React.Fragment key={li}>
            {hasText ? (
              <Text
                // The focus target after the reveal: a screen-reader element of its own (Android: a focusable view).
                ref={li === focusText ? focusTextRef : undefined}
                accessible={li === focusText ? true : undefined}
                accessibilityLabel={li === introText ? headlineLineLabel(texts.map((p) => p.text).join('')) : undefined}
                numberOfLines={fitOneLine ? 1 : undefined}
                adjustsFontSizeToFit={fitOneLine}
                minimumFontScale={0.55}
                style={[
                  inlineStyle(PLAIN, base),
                  tnum,
                  { fontSize: base.size, lineHeight, letterSpacing, color: c[base.color], textAlign: align },
                ]}
              >
                {texts.map((p, pi) => (
                  <Text key={pi} style={inlineStyle(p, base)}>
                    {p.text}
                  </Text>
                ))}
              </Text>
            ) : null}
            {line.map((p, pi) => (p.t !== 'img' ? null : pictureOf(pi)(p.src, `${li}:${pi}`)))}
          </React.Fragment>
        );
      })}
    </View>
  );
}

/** True when a block is one line of plain text (no bold, no image): it can be drawn as a decorated term. */
function isPlainOneLine(block: FieldBlock): boolean {
  return block.lines.length === 1 && block.lines[0].every((p) => p.t === 'text' && !p.b && !p.i && !p.u && !p.sub && !p.sup);
}

/** The headline of a side, sized by its length. */
function Headline({
  block,
  side,
  genderColors,
  renderImage,
  renderIntroImage,
  cardLabel,
  renderFocusImage,
  focusTextRef,
  focusViewRef,
}: {
  block: FieldBlock | undefined;
  side: 'prompt' | 'answer';
  genderColors: boolean;
  renderImage: RenderImage;
  /** Draws a picture that starts the card (see RichLines `renderIntroImage`). */
  renderIntroImage?: RenderImage;
  /** The first thing of the headline carries the card label "Card. {that line}." (see RichLines `cardLabel`). */
  cardLabel?: boolean;
  /**
   * Given = the first thing of the headline is the focus target after the
   * reveal: its first line of text (`focusTextRef`) or its first picture
   * (drawn with this function), see RichLines `renderFocusImage`.
   */
  renderFocusImage?: RenderImage;
  /** The first line of text, when `renderFocusImage` is given. */
  focusTextRef?: React.Ref<Text>;
  /** A gender-coloured term, when `renderFocusImage` is given: one element that reads the term. */
  focusViewRef?: React.Ref<View>;
}) {
  const c = useColors();
  const size = headlineSize(block);
  const head = HEADLINE_STYLES[side][size];
  const align: TextStyle['textAlign'] = size === 'long' ? 'left' : 'center';
  if (!block) return null;
  if (block.role === 'term' && block.lang && genderColors && isPlainOneLine(block) && size !== 'long') {
    const text = blockText(block);
    const term = (
      <TermText
        text={text}
        lang={block.lang}
        style={[
          inlineStyle(PLAIN, head.base),
          { fontSize: head.base.size, lineHeight: head.lineHeight, letterSpacing: head.letterSpacing, color: c.ink, textAlign: align, alignSelf: 'stretch' },
        ]}
      />
    );
    // The focus target after the reveal: one element that reads the term (TermText takes no ref).
    if (!renderFocusImage || text.trim() === '') return term;
    return (
      <View ref={focusViewRef} accessible accessibilityLabel={text} style={{ alignSelf: 'stretch' }}>
        {term}
      </View>
    );
  }
  const oneWord = side === 'prompt' && size === 'big' && block.lines.length === 1 && !/\s/.test(block.plain);
  return (
    <RichLines
      lines={block.lines}
      head={head}
      align={align}
      renderImage={renderImage}
      renderIntroImage={renderIntroImage}
      fitOneLine={oneWord}
      cardLabel={cardLabel}
      renderFocusImage={renderFocusImage}
      focusTextRef={focusTextRef}
    />
  );
}

/** The look of the other question fields: sans 14.5, ink3 (spec §6.2). */
const PROMPT_REST: HeadStyle = { base: { family: 'sans', weight: 400, italic: false, size: 14.5, color: 'ink3' }, lineHeight: 20, letterSpacing: 0 };

/** The other fields of the answer side, by role; runs of 'detail' fields are labelled rows. */
function AnswerRest({
  blocks,
  align,
  renderImage,
}: {
  blocks: FieldBlock[];
  align: TextStyle['textAlign'];
  renderImage: RenderImage;
}) {
  const groups: (FieldBlock | FieldBlock[])[] = [];
  for (const block of blocks) {
    const last = groups[groups.length - 1];
    if (block.role === 'detail') {
      if (Array.isArray(last)) last.push(block);
      else groups.push([block]);
    } else groups.push(block);
  }
  return (
    <View style={{ alignSelf: 'stretch' }}>
      {groups.map((g, i) =>
        Array.isArray(g) ? (
          <FieldRows key={`rows-${i}`} blocks={g} variant="stacked" renderImage={renderImage} style={{ marginTop: 14 }} />
        ) : (
          <View
            key={`b-${g.field}-${i}`}
            // A block with a picture is not one element: the picture stays reachable (R9).
            accessible={!blockHasImage(g)}
            accessibilityLabel={blockHasImage(g) ? undefined : g.label && g.role !== 'example' ? `${g.label}: ${g.plain}` : g.plain}
            style={{ marginTop: g.role === 'example' ? 16 : 8 }}
          >
            <FieldLines lines={g.lines} role={g.role} renderImage={renderImage} style={{ textAlign: align }} />
          </View>
        ),
      )}
    </View>
  );
}

/** The soft paper fade at the bottom of the card body while more content is below. */
function BottomFade({ color }: { color: string }) {
  return (
    <View {...A11Y_HIDDEN} style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 40, pointerEvents: 'none' }}>
      <Svg width="100%" height="100%">
        <Defs>
          <LinearGradient id="studyCardFade" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={color} stopOpacity="0" />
            <Stop offset="1" stopColor={color} stopOpacity="1" />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#studyCardFade)" />
      </Svg>
    </View>
  );
}

interface StudyCardProps {
  /** What to draw: the card's face (useFaces()(card)). */
  face: CardFace;
  /** The card's deck (its images folder). */
  deckId: Id;
  revealed: boolean;
  /** Learning step label ("1/2 · 10m → 1d") or null once graduated. */
  step: string | null;
  /** True when this copy was re-queued by an "Again" rating this session. */
  requeued?: boolean;
  /** A hint was used on this card (the small "hint" pill). */
  hintUsed?: boolean;
  /** Show the read-aloud button (settings.readAloudEnabled). */
  canSpeak: boolean;
  /** `deck.genderColors !== false`: German articles in their gender colour. */
  genderColors: boolean;
  /** A tap on the card reveals it (Flashcards). Undefined in Typing, Quiz and Articles. */
  onReveal?: () => void;
  onSpeak: () => void;
  /** The tallest the card may be (the space between the header and the rating zone). */
  maxHeight?: number;
  /** Replaces the question headline (Articles: the bare word). */
  promptOverride?: React.ReactNode;
  /**
   * What a screen reader says for `promptOverride` ("Abfahrt"). Without it,
   * the label says the face's question, which for Articles would read out
   * the article the learner must choose.
   */
  promptLabel?: string;
  /** Drawn under the question (the typing field, the quiz, the hint, a fallback note). */
  questionExtra?: React.ReactNode;
  /** Drawn on the answer side after the question (the typing result, the picked quiz). */
  answerExtra?: React.ReactNode;
  /**
   * The element of `answerExtra` that takes the screen-reader focus after the
   * reveal when the question has no text line (wave 5h): the first line of
   * the typing result ("You typed: …") or the picked quiz choice. The
   * session gives the same ref to TypingAnswer / QuizChoices (`focusRef`).
   */
  answerExtraFocus?: React.RefObject<FocusTarget | null>;
  /** Replaces the whole answer side (Articles: the result). */
  answerOverride?: React.ReactNode;
}

export function StudyCard({
  face,
  deckId,
  revealed,
  step,
  requeued,
  hintUsed,
  canSpeak,
  genderColors,
  onReveal,
  onSpeak,
  maxHeight,
  promptOverride,
  promptLabel,
  questionExtra,
  answerExtra,
  answerExtraFocus,
  answerOverride,
}: StudyCardProps) {
  const c = useColors();
  const [viewer, setViewer] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  // Scroll numbers live in refs (written in the scroll handlers only); `more` changes only when the fade must.
  const scrollBox = useRef({ view: 0, content: 0, y: 0 });
  const measure = () => {
    const { view, content, y } = scrollBox.current;
    const below = content - y - view > 4;
    if (below !== more) setMore(below);
  };

  const renderImage: RenderImage = (src, key) => <CardImage key={key} deckId={deckId} name={src} onOpen={setViewer} />;
  // A picture that comes first in a Typing / Quiz question headline also starts the card ("Card. Picture.").
  const renderIntroImage: RenderImage = (src, key) => (
    <CardImage key={key} deckId={deckId} name={src} onOpen={setViewer} cardIntro />
  );
  const badges = face.badges.filter(blockHasContent);
  const promptHead = face.prompt[0];
  const answerHead = face.answer[0];
  const promptRest = visibleBlocks(face.prompt.slice(1), true);
  const answerRest = visibleBlocks(face.answer.slice(1), true);
  const answerAlign: TextStyle['textAlign'] = headlineSize(answerHead) === 'long' ? 'left' : 'center';
  // Typing, Quiz and Articles (no tap to reveal): the question headline is ONE element "Card. {question}.",
  // unless it shows a picture: then its first line of text says "Card. {that line}." (only that line, so no
  // text is read twice), and the picture and the later lines stay their own elements (R9, review round 2).
  const headLabel = onReveal ? undefined : cardA11yLabel(face, false, false, promptLabel);
  const groupHead = !onReveal && (promptOverride !== undefined || !blockHasImage(promptHead));
  // The tap area is the "Card. … Double tap to reveal." button ONLY on the front of a card that a
  // tap reveals (Flashcards). Its label, role, `focusable` AND its `key` all come from this one value,
  // so they can never disagree (review round 2, see the tap area below).
  const tapToReveal = !!onReveal && !revealed;
  const minHeight = maxHeight !== undefined ? Math.min(330, maxHeight) : 330;

  // The question line at the top of the answer side, computed once. '' = the question has no
  // text (only a picture): then NO line is drawn — an empty `accessible` Text was a silent
  // TalkBack stop and took the focus (review of C1-5).
  const questionLine = answerQuestionLine(face);
  // The first element of the answer side (the question line). After the reveal the
  // screen-reader focus moves there (C1-5, see the file comment).
  const answerFirst = useRef<Text>(null);
  // With no question line, the focus goes to the first element of the answer headline: its
  // first line of text (answerHeadText), a gender-coloured term or its first picture
  // (answerHeadView). Only one of them is drawn with its ref; the others stay null. With a
  // question line `renderFocusImage` is undefined, so the headline attaches neither ref.
  const answerHeadText = useRef<Text>(null);
  const answerHeadView = useRef<View>(null);
  const renderFocusImage: RenderImage | undefined =
    questionLine === ''
      ? (src, key) => <CardImage key={key} deckId={deckId} name={src} onOpen={setViewer} focusRef={answerHeadView} />
      : undefined;
  // `revealed` at the last commit: the focus moves only when the card turns from
  // the question to the answer, never when a card is drawn already revealed.
  // The target is the FIRST element of the answer side, in reading order: the
  // question line; with no question line, the mode's result (`answerExtraFocus`:
  // the typing result or the picked choice, drawn before the answer headline,
  // so it was skipped — wave 5h, C2 review of wave 5g); else the answer headline.
  const shownRevealed = useRef(revealed);
  useEffect(() => {
    const wasRevealed = shownRevealed.current;
    shownRevealed.current = revealed;
    if (!revealed || wasRevealed) return undefined;
    return focusAfterReveal(
      () => answerFirst.current ?? answerExtraFocus?.current ?? answerHeadText.current ?? answerHeadView.current,
    );
  }, [revealed, answerExtraFocus]);

  return (
    <View>
      {/* the queue, as a stack beneath the card */}
      <View
        {...A11Y_HIDDEN}
        style={{
          position: 'absolute',
          left: 14,
          right: 14,
          bottom: -10,
          height: 30,
          backgroundColor: c.card,
          borderWidth: 1,
          borderColor: c.hairline,
          borderRadius: 18,
          opacity: 0.55,
        }}
      />
      <View
        {...A11Y_HIDDEN}
        style={{
          position: 'absolute',
          left: 7,
          right: 7,
          bottom: -5,
          height: 30,
          backgroundColor: c.card,
          borderWidth: 1,
          borderColor: c.hairline,
          borderRadius: 18,
          opacity: 0.8,
        }}
      />

      <RiseIn duration={280}>
        <View
          style={[
            {
              backgroundColor: c.card,
              borderWidth: 1,
              borderColor: c.hairline,
              borderRadius: 20,
              minHeight,
              maxHeight,
              paddingTop: 14,
              paddingHorizontal: 22,
              paddingBottom: 16,
            },
            c.shadow.card,
          ]}
        >
          {/* top row: its own row (it wraps), never over the text */}
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8, minHeight: 34 }}>
            <View style={{ flex: 1, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, paddingTop: 5 }}>
              {badges.map((b, i) => (
                <FacetBadge key={`badge-${b.field}-${i}`} value={b.plain} label={b.label} style={{ maxWidth: '100%' }} />
              ))}
              {step ? (
                <Pill mono fg={c.amberDeep} bg={c.amberTint} label={`Learning step ${step}`}>
                  {step}
                </Pill>
              ) : null}
              {requeued ? (
                <Pill fg={c.danger} bg={c.dangerTint} label="Again: this card came back">
                  again
                </Pill>
              ) : null}
              {hintUsed ? (
                <Pill fg={c.amberDeep} bg={c.amberTint} label="A hint was used">
                  hint
                </Pill>
              ) : null}
            </View>
            {canSpeak ? (
              <IconBtn
                icon="volume-high-outline"
                size={34}
                iconSize={18}
                color={c.pine}
                bg={c.pineTint}
                label="Read aloud"
                onPress={onSpeak}
              />
            ) : null}
          </View>

          {/* the body scrolls; a paper fade says when more is below */}
          <View style={{ flexShrink: 1, flexGrow: 1, marginTop: 6 }}>
            <ScrollView
              style={{ flexGrow: 1 }}
              contentContainerStyle={{ flexGrow: 1 }}
              // The Typing field and "Check" (and the quiz choices) are inside this
              // ScrollView. With the default ('never'), the first tap while the
              // keyboard is open only closes the keyboard, and "Check" never gets it.
              // 'handled': a tap on a button reaches the button (TypingAnswer closes
              // the keyboard itself); a tap on empty space still closes the keyboard.
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              scrollEventThrottle={48}
              onLayout={(e) => {
                scrollBox.current.view = e.nativeEvent.layout.height;
                measure();
              }}
              onContentSizeChange={(_w, h) => {
                scrollBox.current.content = h;
                measure();
              }}
              onScroll={(e) => {
                scrollBox.current.y = e.nativeEvent.contentOffset.y;
                measure();
              }}
            >
              <Pressable
                // A NEW native view each time the label comes or goes (final device
                // pass K1-2). WHY: Android never clears a screen-reader label that
                // becomes empty (React Native sets the view's content description
                // only when the new text is not empty). So the old view still said
                // "Card. … Double tap to reveal." and could still be found by TalkBack.
                // The label goes away in TWO ways, so the key follows `tapToReveal`
                // (the same value that decides the label), not only `revealed`:
                //   - the reveal (`revealed` becomes true);
                //   - More › Switch mode, Flashcards → Typing / Quiz / Articles, before
                //     the reveal: `onReveal` becomes undefined, `revealed` stays false,
                //     and the card keeps its key in the session (review round 2).
                // The back side has no label of its own: a screen reader reads it
                // element by element.
                key={tapToReveal ? 'front-tap' : revealed ? 'back' : 'front'}
                onPress={revealed ? undefined : onReveal}
                // NOT `|| revealed`: Android's TalkBack says "disabled" for a
                // disabled view, and the answer is not disabled (review round 1).
                disabled={!onReveal}
                // Only the front with "tap to reveal" is a native CLICKABLE view.
                // WHY (review round 1): Pressable passes `focusable: true` by
                // default, and on Android a focusable view gets a click listener,
                // so it is "clickable" even with no onPress and accessible=false.
                // TalkBack then made the whole answer ONE stop (the texts inside
                // read together), not element by element. focusable={false}
                // removes the click listener: no touch changes (React Native
                // handles touches in JavaScript, not with this listener).
                focusable={tapToReveal}
                accessible={tapToReveal}
                accessibilityRole={tapToReveal ? 'button' : undefined}
                accessibilityLabel={tapToReveal ? cardA11yLabel(face, false, true, promptLabel) : undefined}
                style={{ flexGrow: 1, justifyContent: 'center', paddingVertical: 10 }}
              >
                {!revealed ? (
                  /* front — the question */
                  <View style={{ alignItems: 'center' }}>
                    {/* Typing, Quiz and Articles (no tap to reveal): the question headline is
                        ONE element "Card. {question}." (spec §8.12). Only the headline: the
                        typing field, the choices and the hint below stay reachable on their own.
                        A headline with a picture is not grouped (R9, see `groupHead`). */}
                    <View
                      // A new native view when the label goes, for the same reason as the
                      // tap area (K1-2): More › Switch mode, Articles → Typing / Quiz, on a
                      // card whose question shows a picture, makes `groupHead` false while
                      // the tap area keeps its key (review round 2).
                      key={groupHead ? 'head-one' : 'head-parts'}
                      accessible={groupHead}
                      accessibilityLabel={groupHead ? headLabel : undefined}
                      style={{ alignItems: 'center', alignSelf: 'stretch' }}
                    >
                      {promptOverride ?? (
                        <Headline
                          block={promptHead}
                          side="prompt"
                          genderColors={genderColors}
                          renderImage={renderImage}
                          renderIntroImage={renderIntroImage}
                          cardLabel={!onReveal && !groupHead}
                        />
                      )}
                    </View>
                    {promptOverride
                      ? null
                      : promptRest.map((b, i) => (
                          <View
                            key={`prompt-${b.field}-${i}`}
                            // A field with a picture is not one element: the picture stays reachable (R9).
                            accessible={!blockHasImage(b)}
                            accessibilityLabel={blockHasImage(b) ? undefined : b.label ? `${b.label}: ${b.plain}` : b.plain}
                            style={{ marginTop: 12, alignItems: 'center', alignSelf: 'stretch' }}
                          >
                            {b.label ? <Overline style={{ marginBottom: 2 }}>{b.label}</Overline> : null}
                            <RichLines lines={b.lines} head={PROMPT_REST} align="center" renderImage={renderImage} />
                          </View>
                        ))}
                    {questionExtra}
                    {onReveal ? (
                      <View {...A11Y_HIDDEN} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 30 }}>
                        <Ion name="hand-left-outline" size={14} color={c.ink3} />
                        <Text style={[font('sans', 700), { fontSize: 12.5, color: c.ink3 }]}>Tap to reveal</Text>
                      </View>
                    ) : null}
                  </View>
                ) : (
                  /* back — the answer */
                  <RiseIn duration={220} distance={0}>
                    {answerOverride ?? (
                      <View style={{ alignItems: 'center' }}>
                        {questionLine !== '' ? (
                          <Text
                            ref={answerFirst}
                            // A screen-reader element of its own (Android: a focusable view), so the
                            // focus can move here after the reveal (C1-5). It is read as before.
                            accessible
                            numberOfLines={3}
                            style={[font('sans', 700), { fontSize: 14.5, lineHeight: 20, color: c.ink3, textAlign: 'center' }]}
                          >
                            {questionLine}
                          </Text>
                        ) : null}
                        {answerExtra}
                        <View
                          {...A11Y_HIDDEN}
                          style={{ width: 36, height: 1, backgroundColor: c.hairlineStrong, marginVertical: 13 }}
                        />
                        <Headline
                          block={answerHead}
                          side="answer"
                          genderColors={genderColors}
                          renderImage={renderImage}
                          renderFocusImage={renderFocusImage}
                          focusTextRef={answerHeadText}
                          focusViewRef={answerHeadView}
                        />
                        <AnswerRest blocks={answerRest} align={answerAlign} renderImage={renderImage} />
                      </View>
                    )}
                  </RiseIn>
                )}
              </Pressable>
            </ScrollView>
            {more ? <BottomFade color={c.card} /> : null}
          </View>
        </View>
      </RiseIn>

      <ImageViewer uri={viewer} onClose={() => setViewer(null)} />
    </View>
  );
}
