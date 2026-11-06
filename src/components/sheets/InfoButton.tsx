/**
 * InfoButton — the small "?" next to a glossary word (spec §2.3, §8.9, §8.12,
 * unit W4-6). A tap opens the InfoSheet with that word's one meaning.
 *
 *   Session size (?)          ← <InfoButton term="Session size" />
 *
 * Props (pinned by the spec, wave-4b screens use them):
 *   - `term`   a glossary word (src/content/glossary.ts). Case and accents do
 *              not matter; an alias works too ("Flag" → "Favorite / Flag").
 *   - `label`  what a screen reader says (the repo's `label` rule, as on
 *              IconBtn). Default: "What does {word} mean?", where {word} is
 *              the glossary's own spelling of `term` (infoButtonLabel).
 *
 * The button owns its sheet: no state in the screen. The "?" icon is 18 pt,
 * the button 24 pt, and the hit slop makes the touch target 44 pt
 * (`squareSlop`, spec §8.12).
 *
 * WHERE to put it: on a SCREEN, not inside another Sheet. Its InfoSheet can
 * show "More in Help", which opens the /help screen. Every Sheet is a
 * React Native Modal, and a Modal is drawn above the whole navigation
 * stack. So if the "?" sits inside another sheet (for example next to
 * "Daily limit" in a deck settings sheet), Help opens BEHIND that parent
 * sheet, and the learner sees nothing until they close it. Inside a sheet,
 * write the meaning in the sheet itself, or close the parent sheet first.
 *
 * A word that is not in the glossary is a bug in the calling screen: it
 * throws in development, and in a release the "?" is not drawn (a "?" that
 * explains nothing would be a fake control).
 */
import React, { useState } from 'react';

import { IconBtn } from '@/components/ui';
import { glossaryEntry, lookupKey, requireGlossaryEntry } from '@/content/glossary';
import { useColors } from '@/theme/ThemeContext';

import { InfoSheet } from './InfoSheet';

/** The size of the "?" button in points (the hit slop brings the target to 44 pt). */
export const INFO_BUTTON_SIZE = 24;

/**
 * The spelling of `term` that the learner SEES: the glossary word or alias
 * that `term` matches, written as the glossary writes it. A term that
 * matches only an entry's id (a code key such as 'notStarted') gives the
 * entry's word. A word the glossary does not have stays as it is.
 *
 *   shownWord('known')      → 'Known'
 *   shownWord('flag')       → 'Flag'          (an alias)
 *   shownWord('notStarted') → 'Not started'   (an id is never read aloud)
 */
function shownWord(term: string): string {
  const entry = glossaryEntry(term);
  if (!entry) return term;
  const key = lookupKey(term);
  return [entry.word, ...(entry.aliases ?? [])].find((name) => lookupKey(name) === key) ?? entry.word;
}

/**
 * What a screen reader says for the "?" of a word: the word as the glossary
 * spells it (shownWord), never a code id.
 *
 *   infoButtonLabel('Known')      → 'What does Known mean?'
 *   infoButtonLabel('known')      → 'What does Known mean?'
 *   infoButtonLabel('notStarted') → 'What does Not started mean?'
 */
export function infoButtonLabel(term: string): string {
  return `What does ${shownWord(term)} mean?`;
}

export function InfoButton({ term, label }: { term: string; label?: string }) {
  const c = useColors();
  const [open, setOpen] = useState(false);
  const entry = requireGlossaryEntry(term, { dev: __DEV__ });
  if (entry === null) return null;

  return (
    <>
      <IconBtn
        icon="help-circle-outline"
        size={INFO_BUTTON_SIZE}
        iconSize={18}
        color={c.ink3}
        label={label ?? infoButtonLabel(term)}
        onPress={() => setOpen(true)}
      />
      <InfoSheet term={term} open={open} onClose={() => setOpen(false)} />
    </>
  );
}
