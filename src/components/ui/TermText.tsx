/**
 * TermText — a term with its German article drawn in the gender colour
 * (spec §8.13, §9.2):
 *
 *   der → c.info     die → c.danger     das → c.success     plural "die (Pl.)" → c.ink3
 *
 *   <TermText text="die Abfahrt" lang="de-DE" style={headline} />
 *     → "die" in danger red, " Abfahrt" in the style's colour (ink)
 *   <TermText text="the hour" lang="en-US" />   → plain text (not German)
 *
 * The article TEXT is always drawn, so colour is never the only signal
 * (spec §8.12), and a screen reader reads the whole term as one text.
 *
 * When to use it (the caller decides, spec §9.2): only for a field with
 * role 'term', `lang` = the field's resolved language (render.ts
 * resolveFieldLang), and `genderColors` = `deck.genderColors !== false`.
 * The splitting is the language helper's job (src/domain/lang,
 * `termHelpers(lang).decorate`); this component only paints the pieces.
 *
 * `tint` also puts the gender tint behind the article (the Library badge).
 */
import React from 'react';
import { StyleProp, Text, TextStyle } from 'react-native';

import { type GermanGender, type Segment, termHelpers } from '@/domain/lang';
import type { Palette, StatePair } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

/** The palette keys of each gender colour (fg on the article, tint behind it). */
export const GENDER_COLOR_KEYS: Readonly<
  Record<
    GermanGender,
    { fg: 'info' | 'danger' | 'success' | 'ink3'; tint: 'infoTint' | 'dangerTint' | 'successTint' | 'paperSunk' }
  >
> = Object.freeze({
  m: { fg: 'info', tint: 'infoTint' },
  f: { fg: 'danger', tint: 'dangerTint' },
  n: { fg: 'success', tint: 'successTint' },
  pl: { fg: 'ink3', tint: 'paperSunk' },
});

/** The fg / tint colours of a gender. */
export function genderColors(c: Palette, gender: GermanGender): StatePair {
  const keys = GENDER_COLOR_KEYS[gender];
  return { fg: c[keys.fg], tint: c[keys.tint] };
}

/**
 * The pieces to draw. Joining every `text` always gives the input back.
 *
 *   termSegments('die Abfahrt', 'de-DE')        → [{ text: 'die', gender: 'f' }, { text: ' Abfahrt' }]
 *   termSegments('die Abfahrt', 'de-DE', false) → [{ text: 'die Abfahrt' }]   (deck turned colours off)
 *   termSegments('the hour', 'en-US')           → [{ text: 'the hour' }]
 *   termSegments('', 'de-DE')                   → []
 */
export function termSegments(text: string, lang?: string | null, genderColorsOn = true): Segment[] {
  const value = text ?? '';
  if (!genderColorsOn) return value === '' ? [] : [{ text: value }];
  return termHelpers(lang).decorate(value);
}

interface TermTextProps {
  text: string;
  /** The field's resolved BCP-47 language, e.g. 'de-DE'. Missing = no decoration. */
  lang?: string | null;
  /** `deck.genderColors !== false`. Default true. */
  genderColors?: boolean;
  /** Also draw the gender tint behind the article (Library badge). */
  tint?: boolean;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
}

export function TermText({ text, lang, genderColors: on = true, tint, style, numberOfLines }: TermTextProps) {
  const c = useColors();
  const segments = termSegments(text, lang, on);
  return (
    <Text style={style} numberOfLines={numberOfLines}>
      {segments.map((s, i) => {
        if (!s.gender) return s.text;
        const pair = genderColors(c, s.gender);
        return (
          <Text key={i} style={{ color: pair.fg, backgroundColor: tint ? pair.tint : undefined }}>
            {s.text}
          </Text>
        );
      })}
    </Text>
  );
}
