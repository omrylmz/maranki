/**
 * Articles practice (spec §6.3 "Articles", German helper, Practice only):
 * the card shows the bare word, and three buttons ask for its article.
 *
 *          Abfahrt                       ← the card (the word without its article)
 *   [ der ]   [ die ]   [ das ]          ← ArticleButtons, under the card
 *   ─────────── after a pick ───────────
 *   Right                                ← ArticleResult, on the card
 *   die Abfahrt                          ← the article in its gender colour
 *                                           (der c.info · die c.danger · das c.success)
 *   [ Next ]
 *
 * There are no rating buttons, and nothing is written: an Articles session
 * is a Practice session (writesSchedule('practice') === false, H3). "Next"
 * counts a right pick as Good and a wrong one as Again (sessionLogic
 * articleRating), so a missed word comes back 3 cards later and "Practice the
 * {n} you missed" can offer it.
 *
 * The article text is always written out, so colour is never the only
 * signal (spec §8.12).
 */
import React from 'react';
import { Pressable, Text, View } from 'react-native';

import { Btn, TermText } from '@/components/ui';
import type { GermanArticle } from '@/domain/lang';
import { ARTICLE_CHOICES, type ArticleQuestion } from '@/domain/modes';
import { font } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

/** The texts of the Articles practice (exact copy). */
export const ARTICLE_COPY = {
  right: 'Right',
  wrong: 'Not quite',
  next: 'Next',
  ask: 'Choose der, die or das',
} as const;

/** The three article buttons (before the pick). */
export function ArticleButtons({ onPick }: { onPick: (article: GermanArticle) => void }) {
  const c = useColors();
  return (
    <View style={{ flexDirection: 'row', gap: 10 }} accessibilityLabel={ARTICLE_COPY.ask}>
      {ARTICLE_CHOICES.map((article) => (
        <Pressable
          key={article}
          onPress={() => onPick(article)}
          accessibilityRole="button"
          accessibilityLabel={article}
          style={({ pressed }) => ({
            flex: 1,
            alignItems: 'center',
            justifyContent: 'center',
            height: 58,
            borderRadius: 14,
            borderWidth: 1,
            borderColor: c.hairlineStrong,
            backgroundColor: c.card,
            transform: [{ scale: pressed ? 0.96 : 1 }],
          })}
        >
          <Text style={[font('serif', 600), { fontSize: 22, color: c.ink }]}>{article}</Text>
        </Pressable>
      ))}
    </View>
  );
}

/** "Next" after the pick. */
export function ArticleNext({ onNext }: { onNext: () => void }) {
  return (
    <Btn full size="lg" onPress={onNext}>
      {ARTICLE_COPY.next}
    </Btn>
  );
}

interface ArticleResultProps {
  question: ArticleQuestion;
  pick: GermanArticle;
  /** `deck.genderColors !== false`. */
  genderColors: boolean;
}

/** The result on the card: right or wrong, and the word with its article in the gender colour. */
export function ArticleResult({ question, pick, genderColors }: ArticleResultProps) {
  const c = useColors();
  const right = pick === question.article;
  const term = `${question.article} ${question.word}`;
  return (
    <View
      style={{ alignItems: 'center', gap: 8 }}
      accessible
      accessibilityLiveRegion="polite"
      accessibilityLabel={right ? `${ARTICLE_COPY.right}. ${term}.` : `${ARTICLE_COPY.wrong}. You chose ${pick}. It is ${term}.`}
    >
      <Text style={[font('sans', 800), { fontSize: 14, color: right ? c.success : c.danger }]}>
        {right ? ARTICLE_COPY.right : `${ARTICLE_COPY.wrong} — not ${pick}`}
      </Text>
      <TermText
        text={term}
        // The colour is the lesson here: always decorate as German.
        lang={question.lang ?? 'de-DE'}
        genderColors={genderColors}
        style={[font('serif', 600), { fontSize: 36, lineHeight: 40, color: c.ink, textAlign: 'center' }]}
      />
    </View>
  );
}
