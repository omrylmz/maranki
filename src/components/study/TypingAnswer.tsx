/**
 * TypingAnswer — Typing mode on the card (spec §6.3): a text field under the
 * question and "Check". After "Check" it shows what you typed with a letter
 * diff, a verdict line, and the answer when it was not exact:
 *
 *   [ Abfart            ] [Check]
 *   ───────── after Check ─────────
 *   Abfa[h]rt               ← right letters underlined in c.success; the missing "h" in c.danger
 *   Almost — a small typo
 *   Answer: die Abfahrt
 *
 * The letter diff is never colour-only (spec §8.12, final review: for a
 * red-green colour-blind learner c.success and c.danger look alike, and
 * thin 17 pt letters made it worse). Each kind of piece has its own SHAPE:
 *   right   ('same')            underlined;
 *   wrong   ('change', 'extra') struck through, bold, on a c.dangerTint box;
 *   missing ('missing')         the answer's letters, faded, NOT underlined
 *                               (a gap in the underline), on a c.dangerTint box.
 * The screen-reader label names the wrong letters too (typedAnswerLabel):
 * "You typed: die Abfehrt. “e” should be “a”."
 *
 *   "Abfahrt" for "die Abfahrt" (a German term):
 *   Almost — remember the article: **die** Abfahrt
 *
 *   "sleep" for "to sleep / the sleep" (an English word, answerCheck rule 6b):
 *   Almost — remember the “to”: **to** sleep
 *
 * The check itself is answerCheck.ts `checkTyped(input, target)` (case,
 * accents, ß/ss, alternatives, fractions, the German article rule and the
 * English "to / the / a" rule); the session calls
 * it and passes the result back here. The mode only SUGGESTS a rating
 * (exact → Good, close → Hard, wrong → Again): the learner still taps one.
 *
 * "Check" with an empty field is allowed: it shows the answer (and suggests Again).
 * The field is focused when the card appears, and the keyboard's return key checks.
 *
 * Double taps: the FIRST "Check" decides. The return key and the "Check"
 * button together, or a fast double tap, send ONE check (`sent`); the
 * session keeps the first result too (sessionLogic answerRun). The field is
 * a new element for every card (it goes away after "Check"), so `sent`
 * never blocks the next card.
 */
import React, { useRef, useState } from 'react';
import { Keyboard, Text, TextInput, type TextStyle, View } from 'react-native';

import { Btn } from '@/components/ui';
import type { AnswerResult, DiffPart } from '@/domain/answerCheck';
import { font, type Palette } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

import { verdictText } from './sessionLogic';

/** The texts of the typing field (exact copy). */
export const TYPING_COPY = {
  placeholder: 'Type the answer',
  check: 'Check',
  nothing: '(nothing typed)',
  answer: 'Answer:',
} as const;

interface TypingAnswerProps {
  /** The result of "Check", or null before it. */
  result: AnswerResult | null;
  onCheck: (typed: string) => void;
  /** Focus the field when it appears (the keyboard opens). */
  autoFocus?: boolean;
  /** Gets the first line of the result ("You typed: …"): the study card's screen-reader focus target (wave 5h). */
  focusRef?: React.Ref<Text>;
}

/**
 * The style of one piece of the letter diff: a colour AND a shape (see the
 * file header), so a right letter and a wrong one never differ by colour only.
 */
export function diffPieceStyle(op: DiffPart['op'], c: Palette): TextStyle {
  if (op === 'same') return { color: c.success, textDecorationLine: 'underline', textDecorationColor: c.success };
  if (op === 'missing') {
    // The letters that are missing, softer, and with no underline: a gap in the line of right letters.
    return { color: c.danger, opacity: 0.6, textDecorationLine: 'none', backgroundColor: c.dangerTint };
  }
  // 'change' and 'extra': letters that were typed but are wrong.
  return {
    ...font('mono', 700),
    color: c.danger,
    textDecorationLine: 'underline line-through',
    textDecorationColor: c.danger,
    backgroundColor: c.dangerTint,
  };
}

/** A piece of text for the screen reader: “e”, or "a space" for blank letters. */
function spoken(text: string): string {
  return text.trim() === '' ? 'a space' : `“${text}”`;
}

/** The most wrong pieces the label names; the rest are counted ("and 2 more"). */
const LABEL_MAX_PIECES = 3;

/**
 * The screen-reader text of what was typed, WITH the letters that were
 * wrong: the diff's colours and shapes say it on screen, this says it in
 * words (spec §8.12).
 *
 *   'die Abfehrt' for 'die Abfahrt' → 'You typed: die Abfehrt. “e” should be “a”.'
 *   'Abfart' for 'Abfahrt'          → 'You typed: Abfart. “h” is missing.'
 *   'Abfahrtt' for 'Abfahrt'        → 'You typed: Abfahrtt. “t” is extra.'
 *   an exact answer                 → 'You typed: die Abfahrt'
 *   nothing                         → 'You typed: (nothing typed)'
 */
export function typedAnswerLabel(diff: readonly DiffPart[]): string {
  const typedText = diff.map((p) => p.typed).join('');
  if (typedText.trim() === '') return `You typed: ${TYPING_COPY.nothing}`;
  const wrong: string[] = [];
  for (const part of diff) {
    if (part.op === 'change') wrong.push(`${spoken(part.typed)} should be ${spoken(part.expected)}`);
    else if (part.op === 'missing') wrong.push(`${spoken(part.expected)} is missing`);
    else if (part.op === 'extra') wrong.push(`${spoken(part.typed)} is extra`);
  }
  if (wrong.length === 0) return `You typed: ${typedText}`;
  const named = wrong.slice(0, LABEL_MAX_PIECES);
  if (wrong.length > LABEL_MAX_PIECES) named.push(`and ${wrong.length - LABEL_MAX_PIECES} more`);
  return `You typed: ${typedText}. ${named.join('; ')}.`;
}

/** One piece of the letter diff, with its colour and its shape (diffPieceStyle). */
function DiffPiece({ part }: { part: DiffPart }) {
  const c = useColors();
  // A missing piece shows the letters that are missing.
  const text = part.op === 'missing' ? part.expected : part.typed;
  return <Text style={diffPieceStyle(part.op, c)}>{text}</Text>;
}

export function TypingAnswer({ result, onCheck, autoFocus = true, focusRef }: TypingAnswerProps) {
  const c = useColors();
  const [typed, setTyped] = useState('');
  const sent = useRef(false); // true once this field sent its check

  if (result) {
    const exact = result.verdict === 'exact';
    const verdictColor = exact ? c.success : result.verdict === 'close' ? c.warning : c.danger;
    // What was typed, from the diff (the field is gone after Check, and undo shows the result again).
    const typedText = result.diff.map((p) => p.typed).join('');
    const nothingTyped = typedText.trim() === '';
    return (
      <View style={{ marginTop: 16, alignItems: 'center', gap: 6 }}>
        <Text
          ref={focusRef}
          // `accessible`: on Android a Text without it cannot take the
          // screen-reader focus, and this line is the focus target after "Check".
          accessible
          accessibilityLabel={typedAnswerLabel(result.diff)}
          style={[font('mono', 500), { fontSize: 17, lineHeight: 24, color: c.ink, textAlign: 'center' }]}
        >
          {nothingTyped ? (
            <Text style={{ color: c.ink3 }}>{TYPING_COPY.nothing}</Text>
          ) : (
            result.diff.map((part, i) => <DiffPiece key={i} part={part} />)
          )}
        </Text>
        <Text style={[font('sans', 700), { fontSize: 13.5, color: verdictColor, textAlign: 'center' }]}>
          {verdictText(result)}
          {result.reason === 'article' && result.article ? (
            <Text style={{ color: c.ink2 }}>
              {' '}
              <Text style={font('sans', 800)}>{result.article.article}</Text> {result.article.word}
            </Text>
          ) : null}
        </Text>
        {!exact && result.reason !== 'article' ? (
          <Text style={[font('sans', 400), { fontSize: 13.5, color: c.ink2, textAlign: 'center' }]}>
            {TYPING_COPY.answer} <Text style={font('sans', 700)}>{result.expected}</Text>
          </Text>
        ) : null}
      </View>
    );
  }

  const check = () => {
    if (sent.current) return;
    sent.current = true;
    Keyboard.dismiss();
    onCheck(typed);
  };
  return (
    <View style={{ marginTop: 20, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <TextInput
        value={typed}
        onChangeText={setTyped}
        onSubmitEditing={check}
        autoFocus={autoFocus}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        returnKeyType="done"
        submitBehavior="blurAndSubmit"
        placeholder={TYPING_COPY.placeholder}
        placeholderTextColor={c.ink3}
        accessibilityLabel={TYPING_COPY.placeholder}
        style={[
          font('sans', 500),
          {
            flex: 1,
            fontSize: 16.5,
            color: c.ink,
            backgroundColor: c.paperSunk,
            borderWidth: 1,
            borderColor: c.hairline,
            borderRadius: 12,
            paddingVertical: 11,
            paddingHorizontal: 14,
          },
        ]}
      />
      <Btn size="md" onPress={check}>
        {TYPING_COPY.check}
      </Btn>
    </View>
  );
}
