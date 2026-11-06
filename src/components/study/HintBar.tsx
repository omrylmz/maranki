/**
 * Hints in the session (spec §6.4): the "💡 Hint" button under the card and
 * the hint text on the card.
 *
 *   HintBar   the row under the card before the answer is shown:
 *               [💡 Hint] · tap the card to reveal          (Flashcards)
 *               [💡 Hint]                                   (Typing: the card has "Check")
 *             The button says "Hint", then "More hint", then "Show answer"
 *             (the third tap reveals the card, the same as tapping it).
 *             It is a real button (it was a plain View before W4-4). The
 *             session hides it when Settings › Hints is off, in Quiz and
 *             Articles, and after the answer is shown (sessionLogic
 *             showHintButton).
 *   HintText  the hint itself, drawn on the card under the question:
 *               "Ich ____ nach Hause."   (an example with the answer blanked)
 *               "g_ · h___"              (first letters, then half the letters)
 *
 * The hint TEXT comes from src/domain/hints.ts (hintAt); this file only draws it.
 */
import React from 'react';
import { Pressable, Text, View } from 'react-native';

import { A11Y_HIDDEN, Ion } from '@/components/ui';
import type { Hint } from '@/domain/hints';
import { font } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

import { hintButtonLabel } from './sessionLogic';

/** The quiet line next to the hint button in Flashcards mode. */
export const TAP_TO_REVEAL = 'tap the card to reveal';

interface HintBarProps {
  /** Show the hint button (sessionLogic showHintButton). */
  showHint: boolean;
  /** Hint taps so far (0–2). */
  step: number;
  onHint: () => void;
  /** Also say "tap the card to reveal" (Flashcards). */
  tapToReveal: boolean;
}

export function HintBar({ showHint, step, onHint, tapToReveal }: HintBarProps) {
  const c = useColors();
  const label = hintButtonLabel(step);
  return (
    <View style={{ height: 62, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 14 }}>
      {showHint ? (
        <Pressable
          onPress={onHint}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityHint={step >= 2 ? 'Shows the answer' : 'Shows part of the answer'}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: 5,
            paddingVertical: 8,
            paddingHorizontal: 12,
            borderRadius: 999,
            backgroundColor: step > 0 ? c.amberTint : 'transparent',
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <View {...A11Y_HIDDEN}>
            <Ion name="bulb-outline" size={15} color={step > 0 ? c.amberDeep : c.ink3} />
          </View>
          <Text style={[font('sans', 700), { fontSize: 13, color: step > 0 ? c.amberDeep : c.ink2 }]}>{label}</Text>
        </Pressable>
      ) : null}
      {showHint && tapToReveal ? (
        <Text {...A11Y_HIDDEN} style={[font('sans', 400), { fontSize: 13, color: c.ink3, opacity: 0.4 }]}>
          ·
        </Text>
      ) : null}
      {tapToReveal ? (
        <Text style={[font('sans', 400), { fontSize: 13, color: c.ink3 }]}>{TAP_TO_REVEAL}</Text>
      ) : null}
    </View>
  );
}

/** The hint on the card: a soft amber box with the blanked example or the letter mask. */
export function HintText({ hint }: { hint: Hint | null }) {
  const c = useColors();
  if (!hint || hint.kind === 'reveal') return null;
  const example = hint.kind === 'example';
  return (
    <View
      accessible
      accessibilityLabel={`Hint: ${hint.text}`}
      accessibilityLiveRegion="polite"
      style={{
        marginTop: 16,
        alignSelf: 'center',
        maxWidth: '100%',
        backgroundColor: c.amberTint,
        borderRadius: 12,
        paddingVertical: 9,
        paddingHorizontal: 14,
      }}
    >
      <Text
        style={[
          example ? font('serif', 400, true) : font('mono', 500),
          { fontSize: example ? 16 : 15, lineHeight: example ? 23 : 21, color: c.amberDeep, textAlign: 'center' },
        ]}
      >
        {hint.text}
      </Text>
    </View>
  );
}
