/**
 * FieldRows — the fields of a card as labelled rows: an Overline label and
 * the field's text lines (spec §6.2 "detail rows", §8.4 CardSheet, §8.5
 * triage card).
 *
 *   GRAMMAR    -n
 *   EXAMPLE    Die Reise war lang.
 *   LEVEL      B1
 *
 * Input = FieldBlocks from `renderFace` (src/domain/render.ts): each block
 * already holds the field's label, role and its safe-HTML lines
 * (htmlLines.ts). Nothing here reads HTML.
 *
 * Variants:
 *   'side'     (default) label column on the left, text on the right; a
 *              hairlineSoft line between rows (CardSheet). The label column
 *              is LABEL_COLUMN_WIDTH wide at the normal text size and grows
 *              with the system text size (labelColumnWidth). A long label
 *              wraps onto a second line: it is never cut ("PRONUNCIATI…",
 *              walkthrough L3).
 *   'stacked'  label above the text (the study card's detail rows).
 *   'compact'  "LABEL value" pairs that wrap, one line each (triage card).
 *              Text only: a field that holds only an image is left out.
 *
 * How text is drawn (spec §6.2, by role): example = serif italic 16.5 ink2;
 * exampleMeaning = sans 13 ink3; pronunciation = mono 14 ink2; term = serif
 * 17.5 ink; anything else = sans 14.5 ink. Inline styles: b → a bold font,
 * i → italic (the serif's italic font; sans and mono have no italic font,
 * so they get `fontStyle: 'italic'`), u → underline, sub / sup → a smaller
 * size (React Native text has no baseline shift). Each line of the field is
 * its own line.
 *
 * Images: an `img` inline is drawn by `renderImage(src)` when the caller
 * passes it (only the caller knows where the deck's media folder is);
 * otherwise it is left out. Sound tokens are left out: audio is not imported
 * yet (spec §7 #63).
 *
 * Skipped: fields with role 'hidden' and fields with no text and no image
 * (spec §6.2 "empty fields are skipped"). A field that is only a placeholder
 * dash never gets here: renderFace already leaves it out (render.ts).
 *
 * Labels: `block.label` is the field's display label (render.ts
 * fieldDisplayLabel: FieldDef.label, else the readable field name), so an
 * internal name like "MarankiExample" shows as "Example".
 *
 * Accessibility: each row is one element, read "Label: value" (spec §8.12).
 *
 * `FieldLines` (the text lines alone) is exported for the study card.
 */
import React from 'react';
import { StyleProp, Text, TextStyle, useWindowDimensions, View, ViewStyle } from 'react-native';

import type { FieldBlock, FieldRole, Inline } from '@/domain/model';
import { font, type FontFamily, tnum } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

import { Overline } from './layout';

/**
 * The width of the label column of the 'side' variant at the normal text
 * size (font scale 1). 108 pt holds the longest one-word labels of real
 * decks on one line ("PRONUNCIATION" is about 100 pt in the 11 pt label
 * font); longer labels wrap at their spaces ("EXAMPLE / TRANSLATION").
 */
export const LABEL_COLUMN_WIDTH = 108;

/**
 * The largest font scale the 'side' label grows with. The label text uses
 * the same number as its maxFontSizeMultiplier, so text and column grow
 * together and stop together (like the Library rows, ROW_FONT_CAP).
 */
export const LABEL_FONT_CAP = 1.5;

/**
 * The width of the 'side' label column at the phone's font scale (the
 * system text size). The column grows with the label text, so a one-word
 * label that fits at the normal size fits at every size, and it never breaks
 * inside the word ("PRONUNCIA / TION", review of walkthrough L3). Below
 * scale 1 the column stays 108 pt (the smaller text fits anyway).
 *
 *   labelColumnWidth(1)   → 108
 *   labelColumnWidth(1.3) → 141   (108 × 1.3, rounded up)
 *   labelColumnWidth(2)   → 162   (108 × 1.5: the label text stops growing at 1.5 too)
 */
export function labelColumnWidth(fontScale: number): number {
  const scale = Math.min(Math.max(Number.isFinite(fontScale) ? fontScale : 1, 1), LABEL_FONT_CAP);
  return Math.ceil(LABEL_COLUMN_WIDTH * scale);
}

/** The look of one role's text. `color` is a palette key. */
export interface RoleText {
  family: FontFamily;
  weight: number;
  italic: boolean;
  size: number;
  color: 'ink' | 'ink2' | 'ink3';
}

/** The text style of each role inside FieldRows (spec §6.2). */
export function roleText(role: FieldRole): RoleText {
  switch (role) {
    case 'example':
      return { family: 'serif', weight: 400, italic: true, size: 16.5, color: 'ink2' };
    case 'exampleMeaning':
      return { family: 'sans', weight: 400, italic: false, size: 13, color: 'ink3' };
    case 'pronunciation':
      return { family: 'mono', weight: 400, italic: false, size: 14, color: 'ink2' };
    case 'term':
      return { family: 'serif', weight: 500, italic: false, size: 17.5, color: 'ink' };
    default:
      return { family: 'sans', weight: 400, italic: false, size: 14.5, color: 'ink' };
  }
}

/** A text inline (the only kind that is drawn as text). */
type TextInline = Extract<Inline, { t: 'text' }>;

/**
 * `font()` with an italic that always shows. Only the serif has italic font
 * files: `font()` keeps sans and mono upright and drops the italic flag. For
 * those two, `fontStyle: 'italic'` asks the system for a slanted copy of the
 * upright font (Android draws a synthetic slant). The serif never gets
 * `fontStyle`: its italic file is already slanted, and a second slant would
 * be too much.
 *
 *   textFont('serif', 400, true) → { fontFamily: 'Newsreader_400Regular_Italic' }
 *   textFont('sans', 400, true)  → { fontFamily: 'HankenGrotesk_400Regular', fontStyle: 'italic' }
 */
function textFont(family: FontFamily, weight: number, italic: boolean): TextStyle {
  const style = font(family, weight, italic);
  if (italic && family !== 'serif') style.fontStyle = 'italic';
  return style;
}

/**
 * The style of one text inline on top of its role's look. A custom font has
 * one family per weight and style, so bold and italic switch the family
 * (fontWeight would do nothing on Android). Italic sans and mono text has no
 * italic family, so it gets `fontStyle: 'italic'` (see textFont).
 *
 *   inlineStyle({ t: 'text', text: 'ist', b: true }, roleText('detail'))
 *     → { fontFamily: 'HankenGrotesk_700Bold' }
 *   inlineStyle({ t: 'text', text: 'ist', i: true }, roleText('detail'))
 *     → { fontFamily: 'HankenGrotesk_400Regular', fontStyle: 'italic' }
 */
export function inlineStyle(part: TextInline, base: RoleText): TextStyle {
  const style: TextStyle = textFont(base.family, part.b ? Math.max(base.weight, 700) : base.weight, base.italic || !!part.i);
  if (part.u) style.textDecorationLine = 'underline';
  if (part.sub || part.sup) style.fontSize = Math.round(base.size * 0.75 * 10) / 10;
  return style;
}

/** True when a block has something to draw: text, or an image (when images are drawn). */
export function blockHasContent(block: FieldBlock, withImages: boolean): boolean {
  if (block.plain.trim() !== '') return true;
  if (!withImages) return false;
  return block.lines.some((line) => line.some((part) => part.t === 'img'));
}

/** The blocks FieldRows draws, in order: not hidden, not empty. */
export function visibleBlocks(blocks: readonly FieldBlock[], withImages = false): FieldBlock[] {
  return blocks.filter((b) => b.role !== 'hidden' && blockHasContent(b, withImages));
}

/**
 * The screen-reader text of a row: "Example: Die Reise war lang.". A field
 * with no text but images says what it shows ("Picture: image", "Picture: 2
 * images"), never "Picture: " with nothing after the colon (W3-7 hardening).
 * `lines` is only read for that case.
 */
export function fieldRowLabel(block: Pick<FieldBlock, 'label' | 'plain'> & { lines?: FieldBlock['lines'] }): string {
  if (block.plain.trim() !== '') return block.label ? `${block.label}: ${block.plain}` : block.plain;
  let images = 0;
  for (const line of block.lines ?? []) for (const part of line) if (part.t === 'img') images += 1;
  const shown = images === 0 ? '' : images === 1 ? 'image' : `${images} images`;
  if (!shown) return block.label;
  return block.label ? `${block.label}: ${shown}` : shown;
}

/** Draws one image inline; returns null to leave it out. */
export type RenderImage = (src: string, key: string) => React.ReactNode;

interface FieldLinesProps {
  lines: readonly (readonly Inline[])[];
  role: FieldRole;
  renderImage?: RenderImage;
  /** Cut each line to this many lines (compact rows). */
  numberOfLines?: number;
  style?: StyleProp<TextStyle>;
}

/** The lines of one field, styled by role. Images come after the text of their line. */
export function FieldLines({ lines, role, renderImage, numberOfLines, style }: FieldLinesProps) {
  const c = useColors();
  const base = roleText(role);
  const color = c[base.color];
  return (
    <View style={{ gap: 2 }}>
      {lines.map((line, li) => {
        const texts = line.filter((p): p is TextInline => p.t === 'text');
        const images = renderImage ? line.filter((p) => p.t === 'img') : [];
        const hasText = texts.some((p) => p.text.trim() !== '');
        return (
          <React.Fragment key={li}>
            {hasText ? (
              <Text
                numberOfLines={numberOfLines}
                style={[
                  textFont(base.family, base.weight, base.italic),
                  tnum,
                  { fontSize: base.size, lineHeight: Math.round(base.size * 1.4), color },
                  style,
                ]}
              >
                {texts.map((p, pi) => (
                  <Text key={pi} style={inlineStyle(p, base)}>
                    {p.text}
                  </Text>
                ))}
              </Text>
            ) : null}
            {images.map((p, ii) => (p.t === 'img' ? renderImage?.(p.src, `${li}:${ii}`) : null))}
          </React.Fragment>
        );
      })}
    </View>
  );
}

/**
 * A field's label: the Overline look (sans 700, 11 pt, capitals, ink3), but
 * it WRAPS instead of being cut to one line (Overline is one line by design,
 * for section titles). `maxScale` = the largest font scale the text grows
 * with (the 'side' column: LABEL_FONT_CAP); none = it grows without a limit.
 */
function FieldLabel({
  children,
  style,
  maxScale,
}: {
  children: string;
  style?: StyleProp<TextStyle>;
  maxScale?: number;
}) {
  const c = useColors();
  return (
    <Text
      maxFontSizeMultiplier={maxScale}
      style={[
        font('sans', 700),
        { fontSize: 11, lineHeight: 15, letterSpacing: 11 * 0.09, textTransform: 'uppercase', color: c.ink3 },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

interface FieldRowsProps {
  blocks: readonly FieldBlock[];
  variant?: 'side' | 'stacked' | 'compact';
  renderImage?: RenderImage;
  style?: StyleProp<ViewStyle>;
}

export function FieldRows({ blocks, variant = 'side', renderImage, style }: FieldRowsProps) {
  const c = useColors();
  // The system text size: the 'side' label column grows with it (labelColumnWidth).
  const { fontScale } = useWindowDimensions();
  // 'compact' draws only the text (one short line per field), never images:
  // an image-only field would be a label with nothing after it, so it is
  // left out there (W3-7 hardening).
  const shown = visibleBlocks(blocks, variant !== 'compact' && !!renderImage);
  if (shown.length === 0) return null;

  if (variant === 'compact') {
    return (
      <View style={[{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 14, rowGap: 6 }, style]}>
        {shown.map((b, i) => (
          <View
            key={`${b.field}:${i}`}
            accessible
            accessibilityLabel={fieldRowLabel(b)}
            style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6, maxWidth: '100%' }}
          >
            <Overline>{b.label}</Overline>
            <Text
              numberOfLines={1}
              style={[font('sans', 400), { flexShrink: 1, fontSize: 13, color: c.ink2 }]}
            >
              {b.plain}
            </Text>
          </View>
        ))}
      </View>
    );
  }

  const stacked = variant === 'stacked';
  return (
    <View style={style}>
      {shown.map((b, i) => (
        <View
          key={`${b.field}:${i}`}
          accessible
          accessibilityLabel={fieldRowLabel(b)}
          style={{
            flexDirection: stacked ? 'column' : 'row',
            alignItems: stacked ? 'stretch' : 'flex-start',
            gap: stacked ? 4 : 12,
            paddingVertical: 9,
            borderTopWidth: i === 0 ? 0 : 1,
            borderTopColor: c.hairlineSoft,
          }}
        >
          <FieldLabel
            maxScale={stacked ? undefined : LABEL_FONT_CAP}
            style={stacked ? undefined : { width: labelColumnWidth(fontScale), marginTop: 3 }}
          >
            {b.label}
          </FieldLabel>
          <View style={{ flex: stacked ? undefined : 1, minWidth: 0 }}>
            <FieldLines lines={b.lines} role={b.role} renderImage={renderImage} />
          </View>
        </View>
      ))}
    </View>
  );
}
