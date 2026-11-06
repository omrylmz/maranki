/**
 * QuizChoices — Quiz mode on the card (spec §6.3): 4 answers, the right one
 * and 3 distractors (distractors.ts; fixed when the session starts, in a
 * seeded order, so render stays pure).
 *
 *   ( the minute )
 *   ( the hour   ) ✓      ← after a pick: the right answer in c.success,
 *   ( the day    ) ✗         a wrong pick in c.danger, the others dimmed
 *   ( the week   )
 *
 * A pick shows the answer side and SUGGESTS a rating (right → Good, wrong →
 * Again). The learner still taps one of the 4 rating buttons. After the pick
 * the choices are no longer buttons.
 *
 * Double taps: the FIRST tap decides. A second tap on another choice before
 * the screen is drawn again (two fingers, a fast double tap) is ignored here
 * (`sentFor`), and the session keeps the first answer too (sessionLogic
 * answerRun).
 */
import React, { useRef } from 'react';
import { Pressable, Text, View } from 'react-native';

import { A11Y_HIDDEN, Ion } from '@/components/ui';
import type { QuizQuestion } from '@/domain/distractors';
import { font } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

/** The screen-reader text of a choice after the pick. */
export function choiceA11yLabel(text: string, i: number, quiz: QuizQuestion, pick: number | null): string {
  const base = `Answer ${i + 1} of ${quiz.choices.length}: ${text}`;
  if (pick === null) return base;
  if (i === quiz.answerIndex) return `${base}. Right answer${pick === i ? ', your choice' : ''}.`;
  if (i === pick) return `${base}. Your choice, wrong.`;
  return `${base}.`;
}

interface QuizChoicesProps {
  quiz: QuizQuestion;
  /** The picked choice, or null before the pick. */
  pick: number | null;
  onPick: (index: number) => void;
  /** Gets the PICKED choice: the study card's screen-reader focus target after the pick (wave 5h). */
  focusRef?: React.Ref<View>;
}

export function QuizChoices({ quiz, pick, onPick, focusRef }: QuizChoicesProps) {
  const c = useColors();
  const picked = pick !== null;
  // The question a pick was already sent for. A new question (another card, Switch mode,
  // a card edited) is a new object, so it can be answered again.
  const sentFor = useRef<QuizQuestion | null>(null);
  const choose = (i: number) => {
    if (picked || sentFor.current === quiz) return;
    sentFor.current = quiz;
    onPick(i);
  };
  return (
    <View style={{ marginTop: 18, gap: 8, alignSelf: 'stretch' }}>
      {quiz.choices.map((text, i) => {
        const right = picked && i === quiz.answerIndex;
        const wrong = picked && i === pick && i !== quiz.answerIndex;
        const fg = right ? c.success : wrong ? c.danger : c.ink;
        return (
          <Pressable
            key={i}
            ref={pick === i ? focusRef : undefined}
            onPress={picked ? undefined : () => choose(i)}
            disabled={picked}
            accessibilityRole="button"
            accessibilityState={{ disabled: picked, selected: pick === i }}
            accessibilityLabel={choiceA11yLabel(text, i, quiz, pick)}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
              minHeight: 48,
              paddingVertical: 11,
              paddingHorizontal: 16,
              borderRadius: 14,
              borderWidth: right || wrong ? 2 : 1,
              borderColor: right ? c.success : wrong ? c.danger : c.hairlineStrong,
              backgroundColor: right ? c.successTint : wrong ? c.dangerTint : c.surface,
              opacity: picked && !right && !wrong ? 0.55 : 1,
              transform: [{ scale: pressed ? 0.98 : 1 }],
            })}
          >
            <Text style={[font('sans', 600), { flex: 1, fontSize: 15, lineHeight: 21, color: fg }]}>{text}</Text>
            {right || wrong ? (
              <View {...A11Y_HIDDEN}>
                <Ion name={right ? 'checkmark-circle' : 'close-circle'} size={20} color={fg} />
              </View>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}
