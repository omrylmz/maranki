/**
 * InfoSheet — "What does this word mean?" (spec §2.3, §8.9, unit W4-6).
 *
 * Opened by the "?" next to a glossary word (InfoButton.tsx), or by any
 * screen that keeps its own `term` state. It shows the word's one meaning
 * from src/content/glossary.ts — the same text as Help › "Words we use" —
 * and, when the word has a Help section, a "More in Help" button that opens
 * `/help?topic=<id>`.
 *
 *   ┌───────────────────────────────────┐
 *   │ Known                              │   ← the glossary word (header)
 *   │ You said you already know it. It   │   ← the meaning (**bold** kept)
 *   │ is not studied. A few Known cards  │
 *   │ come back once for a Check.        │
 *   │ [ ? More in Help                 ] │   ← only when the word has a topic
 *   │     Choosing what to learn         │
 *   └───────────────────────────────────┘
 *
 * Props (pinned by the spec, wave-4b screens use them):
 *   - `term`    a glossary word ("Known", "Session size"); null = nothing to show.
 *   - `open`    the sheet is shown. With `term` null, it stays closed.
 *   - `onClose` the scrim, Android back and "More in Help" call it.
 *
 * Example:
 *   const [info, setInfo] = useState<string | null>(null);
 *   <InfoSheet term={info} open={info !== null} onClose={() => setInfo(null)} />
 *
 * The sheet keeps showing the last word while it slides away, even when the
 * parent sets `term` to null in the same moment ("adjust state during
 * render": `shown` remembers the last entry, no effect needed).
 *
 * WHERE to open it: from a SCREEN, not from inside another Sheet, when the
 * word has a Help section. "More in Help" closes only THIS sheet, then
 * opens /help. Every Sheet is a React Native Modal, drawn above the whole
 * navigation stack, so a parent sheet that stays open would cover the Help
 * screen until the learner closes it. Inside a sheet, show the meaning in
 * that sheet instead, or close the parent sheet first.
 *
 * A word that is not in the glossary is a bug in the calling screen: it
 * throws in development and shows nothing in a release
 * (`requireGlossaryEntry`).
 *
 * `ContentText` (exported) draws one content text with its markup (bold,
 * code). The Help screen (wave 4b) draws its paragraphs with it too.
 */
import { type Href, useRouter } from 'expo-router';
import React, { useState } from 'react';
import { type StyleProp, Text, type TextStyle, View } from 'react-native';

import { Btn, Sheet } from '@/components/ui';
import { type GlossaryEntry, requireGlossaryEntry, textSpans } from '@/content/glossary';
import { helpPath, helpSection } from '@/content/help';
import { font } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

/** The button text that opens the word's Help section. */
export const INFO_MORE_COPY = 'More in Help';

interface InfoSheetProps {
  term: string | null;
  open: boolean;
  onClose: () => void;
}

export function InfoSheet({ term, open, onClose }: InfoSheetProps) {
  const c = useColors();
  const router = useRouter();
  const entry = term === null ? null : requireGlossaryEntry(term, { dev: __DEV__ });

  // The last word that was asked for: still drawn while the sheet slides out.
  const [shown, setShown] = useState<GlossaryEntry | null>(entry);
  if (entry !== null && entry !== shown) setShown(entry);

  const topic = shown?.topic ? helpSection(shown.topic) : null;

  const openHelp = () => {
    if (!topic) return;
    onClose();
    // helpPath() returns a plain string ('/help?topic=…'), and expo-router's
    // typed routes check only literal paths: `as Href` says "this is a route".
    router.push(helpPath(topic.id) as Href);
  };

  return (
    <Sheet open={open && entry !== null} onClose={onClose} title={shown?.word}>
      {shown ? (
        <View style={{ paddingBottom: 4 }}>
          <ContentText
            text={shown.meaning}
            style={[font('sans', 400), { fontSize: 15.5, lineHeight: 23, color: c.ink2 }]}
          />
          {topic ? (
            <Btn
              kind="secondary"
              size="sm"
              icon="help-buoy-outline"
              sub={topic.title}
              onPress={openHelp}
              style={{ marginTop: 18 }}
            >
              {INFO_MORE_COPY}
            </Btn>
          ) : null}
        </View>
      ) : null}
    </Sheet>
  );
}

/**
 * One content text (a glossary meaning, a Help paragraph) with its markup:
 * `**bold**` → the bold font in ink; `` `code` `` → the mono font. `style`
 * is the plain text's style; the pieces inherit its size and line height.
 *
 *   <ContentText text="Tap **Save as list**." style={...} />
 */
export function ContentText({ text, style }: { text: string; style?: StyleProp<TextStyle> }) {
  const c = useColors();
  return (
    <Text style={style}>
      {textSpans(text).map((span, i) => (
        <Text
          key={i}
          style={
            span.style === 'bold'
              ? [font('sans', 700), { color: c.ink }]
              : span.style === 'code'
                ? [font('mono', 400), { color: c.ink }]
                : undefined
          }
        >
          {span.text}
        </Text>
      ))}
    </Text>
  );
}
