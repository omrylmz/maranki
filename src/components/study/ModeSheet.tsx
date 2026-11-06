/**
 * ModeSheet — choose how to study (spec §2.3, §6.3, §6.5, §8.2). Opened from
 * two places:
 *
 *   Session More › "Switch mode"      <ModeSheet open current={mode} onPickMode={switchTo}
 *                                                showArticle={articleChipShown(kind, mode, n, startMode)} … />
 *     the mode row only; the new mode applies to the REST of this session
 *     (the session recomputes the per-card plans, modes.ts `planCards`).
 *
 *   Deck page "More ways to study ›"  <ModeSheet open current={mode ?? defaultMode}
 *                                                onPickMode={(m) => setMode(pickNextMode(m, defaultMode))}
 *                                                ways={[{ key: 'ahead', label: 'Study ahead', count: 12, onPress }, …]} … />
 *     the "ways" rows first ("Study ahead · 12", "Practice all · 1,240",
 *     "Practice your hardest · 30", "Practice articles · 86"), then the mode
 *     row for the session the learner starts here. `defaultMode` = Settings ›
 *     Default mode; `pickNextMode` (deckPageLogic.ts) keeps NO pick when the
 *     learner picks the default mode again. The page clears the pick when it
 *     starts a session (deckPageLogic.ts `launchMode`), so it is for that ONE
 *     session (walkthrough M4). Never pass `onPickMode={setMode}` here: that
 *     pick would stay on for every later session.
 *
 * The mode row is Flashcards · Typing · Quiz · Mixed, plus Articles only when
 * `showArticle`. It is a row of chips that wraps on a narrow phone, so no
 * label is ever cut. A line under it says what the chosen mode does.
 *
 * `showArticle` — pass true ONLY in a PRACTICE session's "Switch mode", when
 * at least 4 German nouns are still to come (modes.ts `canOfferArticles`),
 * when the session is in Articles now (so its chip is shown active), or when
 * it started in Articles and a noun is still to come (so the learner can come
 * back to it after trying another mode; sessionLogic `articleChipShown`).
 * Articles is "Practice only" (spec §6.3): it has no rating buttons and
 * writes nothing, so a Study session must never switch to it. On the deck
 * page Articles is a way row ("Practice articles · {n}", spec §8.2), never a
 * chip: when `ways` is given, `showArticle` is ignored. (modes.ts `planCard`
 * also shows Articles cards as flashcards outside Practice.)
 *
 * Rules:
 *   - A way row is shown only when its count is above 0 (`shownWays`). A tap
 *     closes the sheet, then calls the row's `onPress` (it opens a session).
 *   - Picking a mode calls `onPickMode(mode)` (not for the mode that is
 *     already chosen). In the session (no `ways`) the switch is then done,
 *     so the sheet closes. On the deck page (`ways` given) it stays open, so
 *     the learner can still pick a way to study.
 *   - The sheet never writes the store: the mode is for one session only
 *     (Settings › Study & limits › "Default mode" keeps the default). In the
 *     session it is for the rest of THIS session (MODE_SCOPE_COPY); on the
 *     deck page it is for the NEXT session started there, then the page goes
 *     back to the default mode (MODE_SCOPE_COPY_DECK, deckPageLogic.ts
 *     `launchMode`). The words under the mode row say exactly that
 *     (walkthrough M4: they said "this session" while the pick stayed on).
 *
 * Paper & ink kit only: Sheet, ListRow, Overline, Chip, useColors().
 */
import React from 'react';
import { Text, View } from 'react-native';

import { Chip, ListRow, Overline, Sheet } from '@/components/ui';
import type { StudyMode } from '@/domain/model';
import { MODE_HINTS, MODE_LABELS, modeChoices, shownWays, wayTitle } from '@/domain/modes';
import { font } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

/** The sheet title in the session ("Switch mode") and on the deck page ("More ways to study"). */
export const MODE_SHEET_TITLES = { session: 'Switch mode', deck: 'More ways to study' } as const;

/**
 * The line under the mode row: the choice is not saved as the default mode.
 * "default mode" = the name of the Settings row (spec §8.6 "Default mode"; one meaning per word, §1.2).
 */
export const MODE_SCOPE_COPY = 'Only for this session. Your default mode is in Settings.';

/**
 * The same line on the deck page ("More ways to study"): the pick is used by
 * the next session started on the page, then the default mode applies again.
 */
export const MODE_SCOPE_COPY_DECK = 'Only for the next session you start here. Your default mode is in Settings.';

export function ModeSheet(props: {
  open: boolean;
  onClose: () => void;
  current: StudyMode;
  onPickMode: (mode: StudyMode) => void;
  ways?: { key: string; label: string; count: number; sub?: string; onPress: () => void }[];
  showArticle?: boolean;
}) {
  const { open, onClose, current, onPickMode, ways, showArticle = false } = props;
  const c = useColors();
  const shown = shownWays(ways);
  // The deck page (`ways` given) never has an Articles chip: it is the "Practice articles" row there.
  const choices = modeChoices(showArticle && !ways);

  const pick = (mode: StudyMode) => {
    if (mode !== current) onPickMode(mode);
    // In the session the switch is done; on the deck page a way is still to be chosen.
    if (!ways) onClose();
  };

  return (
    <Sheet open={open} onClose={onClose} title={ways ? MODE_SHEET_TITLES.deck : MODE_SHEET_TITLES.session}>
      {shown.map((way, i) => (
        <ListRow
          key={way.key}
          title={wayTitle(way.label, way.count)}
          sub={way.sub}
          last={i === shown.length - 1}
          onPress={() => {
            onClose();
            way.onPress();
          }}
        />
      ))}

      <Overline header style={{ marginTop: shown.length > 0 ? 20 : 2, marginBottom: 4 }}>
        Study mode
      </Overline>
      <View
        style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 8, rowGap: 14, paddingVertical: 8 }}
      >
        {choices.map((mode) => (
          <Chip key={mode} active={mode === current} onPress={() => pick(mode)}>
            {MODE_LABELS[mode]}
          </Chip>
        ))}
      </View>
      <Text style={[font('sans', 400), { fontSize: 13.5, lineHeight: 20, color: c.ink2, marginTop: 4 }]}>
        {MODE_HINTS[current]}
      </Text>
      <Text style={[font('sans', 400), { fontSize: 12.5, lineHeight: 18, color: c.ink3, marginTop: 4 }]}>
        {ways ? MODE_SCOPE_COPY_DECK : MODE_SCOPE_COPY}
      </Text>
    </Sheet>
  );
}
