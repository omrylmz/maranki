/**
 * ImageViewer — one card picture, full screen (spec §5.8). Shared by the
 * study card (StudyCard.tsx) and the CardSheet (CardSheet.tsx): a tap on a
 * picture of a card opens it, in a session AND in the Library's card sheet.
 *
 *   const [viewer, setViewer] = useState<string | null>(null);
 *   <Pressable accessibilityHint={OPEN_IMAGE_HINT} onPress={() => setViewer(uri)}>…</Pressable>
 *   <ImageViewer uri={viewer} onClose={() => setViewer(null)} />
 *
 * WHY shared (wave 5i, release re-measure): in a session a tap on a picture
 * opened it full screen, but in the Library's card sheet the same tap did
 * nothing. The viewer lived inside StudyCard.tsx; now both screens use this
 * one, so it looks and closes the same everywhere.
 *
 * How it looks and closes:
 *   - A native Modal (fade). A tap anywhere, the ✕ button ("Close image"),
 *     or Android's hardware Back (Modal `onRequestClose`) closes it. Opened
 *     from a sheet, it is a modal on top of the sheet's modal, so Back
 *     closes the picture first and the sheet stays open.
 *   - The backdrop is OPAQUE, in the colour of the card's sunk well
 *     (`paperSunk`). WHY (final device pass K1-4): it was 92% black, so with
 *     a transparent PNG the card's own copy of the image showed through, and
 *     two images lay on top of each other.
 *   - The picture itself sits on the image well (`imageWell`, ViewerImage),
 *     light in both themes, like on the card. WHY (wave 5g): many imported
 *     pictures are drawings with black lines on a transparent background. In
 *     Evening the backdrop is dark, and on it those lines could not be seen;
 *     on the light well they look the same as on the card.
 */
import { Image } from 'expo-image';
import React, { useState } from 'react';
import { Modal, Pressable, View } from 'react-native';

import { useColors } from '@/theme/ThemeContext';

import { IconBtn } from './buttons';

/** The screen-reader label of the full-screen image's backdrop and its ✕ button. */
export const CLOSE_IMAGE_LABEL = 'Close image';

/** The screen-reader hint of a card picture that opens this viewer. */
export const OPEN_IMAGE_HINT = 'Shows the image full screen';

/** A width and a height (dp). */
export interface BoxSize {
  width: number;
  height: number;
}

/**
 * The size of a picture drawn whole inside a box ("contain"): as big as it
 * fits, at the picture's own shape (`ratio` = width / height). Null while the
 * box or the picture's shape is not known yet (or one is not a real size).
 *
 *   containSize({ width: 300, height: 600 }, 2)    → { width: 300, height: 150 }  (wide: full width)
 *   containSize({ width: 300, height: 600 }, 0.25) → { width: 150, height: 600 }  (tall: full height)
 */
export function containSize(box: BoxSize | null, ratio: number | null): BoxSize | null {
  if (!box || ratio === null || !Number.isFinite(ratio) || ratio <= 0) return null;
  if (!Number.isFinite(box.width) || !Number.isFinite(box.height) || box.width <= 0 || box.height <= 0) return null;
  const width = Math.min(box.width, box.height * ratio);
  return { width, height: width / ratio };
}

/**
 * The picture of the full-screen view, on the image well. The well has the
 * picture's own shape and size (containSize), so it sits exactly behind the
 * picture, and the backdrop around it keeps its colour. Before the picture
 * has loaded (its shape is not known yet) there is no well. ImageViewer
 * makes it again for each picture (`key={uri}`), so an old shape is never used.
 */
function ViewerImage({ uri }: { uri: string }) {
  const c = useColors();
  const [box, setBox] = useState<BoxSize | null>(null);
  const [ratio, setRatio] = useState<number | null>(null);
  const well = containSize(box, ratio);
  return (
    <View
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        setBox((old) => (old && old.width === width && old.height === height ? old : { width, height }));
      }}
      style={{ flex: 1, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center' }}
    >
      <View
        style={
          well
            ? { width: well.width, height: well.height, borderRadius: 10, overflow: 'hidden', backgroundColor: c.imageWell }
            : { width: '100%', height: '100%' }
        }
      >
        <Image
          source={{ uri }}
          contentFit="contain"
          onLoad={(event) => {
            const { width, height } = event.source;
            if (width > 0 && height > 0) setRatio(width / height);
          }}
          style={{ width: '100%', height: '100%' }}
        />
      </View>
    </View>
  );
}

/**
 * The full-screen image: shown while `uri` is not null. A tap anywhere, the
 * ✕ button or Android's Back calls `onClose` (see the file comment).
 */
export function ImageViewer({ uri, onClose }: { uri: string | null; onClose: () => void }) {
  const c = useColors();
  return (
    <Modal visible={uri !== null} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel={CLOSE_IMAGE_LABEL}
        style={{ flex: 1, backgroundColor: c.paperSunk, justifyContent: 'center', padding: 12 }}
      >
        {uri ? <ViewerImage key={uri} uri={uri} /> : null}
      </Pressable>
      <View style={{ position: 'absolute', top: 44, right: 16 }}>
        <IconBtn icon="close" color={c.ink} bg={c.card} border label={CLOSE_IMAGE_LABEL} onPress={onClose} />
      </View>
    </Modal>
  );
}
