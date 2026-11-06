/**
 * Import wizard — the "Done" stage (spec §5.6, §5.9).
 *
 * The words come from `doneCopy` (src/domain/importFile.ts), which reads the
 * ImportResult of `applyImport` — what REALLY happened, not the preview:
 *   - queue mode:  "{deck} is ready" · "{n} cards added" · primary
 *                  "Study {k} now" (only when k > 0) · secondary "Open deck";
 *   - choose mode: primary "Choose what to learn" · secondary "Open deck";
 *   - updates only: "Updated {n} cards ({u} items) in {decks}." "Nothing new.";
 *   - nothing changed: "Already up to date.".
 * Extra lines: "{u} items updated · {s} items skipped (already here)", "{k}
 * cards marked Known (easier levels).", and an honest line when images or
 * the save failed. Every number says its unit, cards or items (wave 5g,
 * walkthrough E8: "1,000 cards added" and "4,000 updated" mixed them).
 * Images are written only after a save that committed (spec §5.8). When the
 * save failed, they wait (`imagesWaiting`): "Copy images" saves again and
 * then writes them.
 *
 * `studyCount` is the size of the session "Study {k} now" opens (the screen
 * counts it with the same function the session uses), so the number on the
 * button is the session it opens.
 */
import React from 'react';
import { Pressable, Text, View } from 'react-native';

import { Btn, Ion, RiseIn } from '@/components/ui';
import type { DoneCopy } from '@/domain/importFile';
import { font, tnum } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

interface DoneStageProps {
  copy: DoneCopy;
  /** Lines about a problem after the import (images not copied, not saved yet). */
  warnings: string[];
  /** Cards ready in the deck now: "Study {k} now". */
  studyCount: number;
  /** The deck the import went into; null = no deck to open (every item was updated elsewhere). */
  hasDeck: boolean;
  /** True when the images were not written because the save failed: shows "Copy images". */
  imagesWaiting?: boolean;
  /** True while "Copy images" saves and writes. */
  copyingImages?: boolean;
  onCopyImages?: () => void;
  onStudy: () => void;
  onChoose: () => void;
  onOpenDeck: () => void;
  onDone: () => void;
}

export function DoneStage({
  copy,
  warnings,
  studyCount,
  hasDeck,
  imagesWaiting = false,
  copyingImages = false,
  onCopyImages,
  onStudy,
  onChoose,
  onOpenDeck,
  onDone,
}: DoneStageProps) {
  const c = useColors();
  const ok = copy.mode === 'queue' || copy.mode === 'choose';
  return (
    <RiseIn duration={300}>
      <View style={{ alignItems: 'center', paddingVertical: 36, paddingHorizontal: 10 }}>
        <View
          style={{
            width: 60,
            height: 60,
            borderRadius: 999,
            backgroundColor: c.pineTint,
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 16,
          }}
        >
          <Ion name={ok || copy.mode === 'updated' ? 'checkmark' : 'checkmark-done'} size={30} color={c.pine} />
        </View>
        <Text
          accessibilityRole="header"
          style={[font('serif', 600), { fontSize: 23, color: c.ink, marginBottom: 6, textAlign: 'center' }]}
        >
          {copy.title}
        </Text>
        {copy.lines.map((line) => (
          <Text key={line} style={[font('sans', 400), tnum, { fontSize: 13.5, color: c.ink3, textAlign: 'center', marginTop: 2 }]}>
            {line}
          </Text>
        ))}
        {warnings.map((line) => (
          <Text key={line} style={[font('sans', 600), { fontSize: 13, color: c.danger, textAlign: 'center', marginTop: 8 }]}>
            {line}
          </Text>
        ))}
        {imagesWaiting && onCopyImages ? (
          <Btn
            kind="secondary"
            size="sm"
            icon="images-outline"
            disabled={copyingImages}
            style={{ alignSelf: 'center', marginTop: 12 }}
            onPress={onCopyImages}
          >
            {copyingImages ? 'Copying images…' : 'Copy images'}
          </Btn>
        ) : null}

        <View style={{ alignSelf: 'stretch', gap: 10, marginTop: 24 }}>
          {copy.mode === 'queue' && studyCount > 0 ? (
            <Btn full size="lg" icon="play" onPress={onStudy}>
              {`Study ${studyCount.toLocaleString('en-US')} now`}
            </Btn>
          ) : null}
          {copy.mode === 'choose' ? (
            <Btn full size="lg" icon="albums-outline" onPress={onChoose}>
              Choose what to learn
            </Btn>
          ) : null}
          {hasDeck ? (
            <Btn
              full
              kind={(copy.mode === 'queue' && studyCount > 0) || copy.mode === 'choose' ? 'secondary' : 'primary'}
              icon="folder-open-outline"
              onPress={onOpenDeck}
            >
              Open deck
            </Btn>
          ) : null}
        </View>
        <Pressable onPress={onDone} style={{ marginTop: 16 }} hitSlop={8} accessibilityRole="button">
          <Text style={[font('sans', 700), { fontSize: 14, color: c.ink2 }]}>Done</Text>
        </Pressable>
      </View>
    </RiseIn>
  );
}
