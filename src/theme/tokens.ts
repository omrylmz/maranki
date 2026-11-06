/**
 * Maranki design tokens — the "paper & ink" system.
 * Source of truth: design/colors_and_type.css (light ":root" + evening "[data-theme=dark]").
 * Every hex below is copied verbatim from that file; do not tweak values here
 * without updating the design system.
 *
 * Text contrast (WCAG AA, spec §8.12; uiContrast.test.ts checks it in both
 * themes): every TEXT colour reads at least 4.5:1 on the surface it is drawn
 * on. Final review 2026-11 changed four values for it (and the CSS with them):
 *   - Paper ink3 #8B8478 → #6C665B (3.26:1 on paper; now 5.0:1, 4.6:1 on paperSunk);
 *   - Evening ink3 #8E8676 → #978F7F (4.21:1 on a card; now 4.7:1);
 *   - Evening inkOnColor #FBF8F2 → #1C1916: dark ink on the bright Evening
 *     pine (white was 2.93:1 on "Study {n}"; now 5.6:1);
 *   - inkOnAmber / inkOnDanger (new): the text on an amber or a red fill
 *     (white was 2.7:1 / 2.3:1 on amber, 3.6:1 on the Evening red).
 *
 * `imageWell` (wave 5g, app-only: not in the CSS file yet) is the colour
 * behind a card's picture. It is LIGHT in both themes. WHY (final device
 * pass, Evening): many imported pictures are drawings with black lines on a
 * transparent background. On the dark Evening well (paperSunk #151310)
 * black lines read at 1.1:1, so they could not be seen. Paper keeps its
 * well (= paperSunk, nothing changes there); Evening uses Paper's page
 * colour #E7E0D2, a light warm paper (black on it: 16:1).
 */
import { Platform, TextStyle, ViewStyle } from 'react-native';

/* ---------------------------------------------------------------- colors */

export interface StatePair {
  fg: string;
  tint: string;
}

export interface Palette {
  /* neutrals */
  paper: string;
  paperSunk: string;
  surface: string;
  card: string;
  cardHover: string;
  ink: string;
  ink2: string;
  ink3: string;
  /** Text on a pine fill (the primary button). */
  inkOnColor: string;
  /** Text on an amber fill (the reward button, the Today tab badge). */
  inkOnAmber: string;
  /** Text on a red fill (the dangerSolid button). */
  inkOnDanger: string;
  hairline: string;
  hairlineStrong: string;
  hairlineSoft: string;
  /**
   * The well behind a card's picture (StudyCard, its full-screen view,
   * CardSheet). Light in BOTH themes, so black line art on a transparent
   * picture stays readable (see the file comment).
   */
  imageWell: string;
  /* cross-theme semantic surfaces */
  pageBg: string;
  tabbarBg: string;
  inverseSurface: string;
  inverseText: string;
  inverseAccent: string;
  scrim: string;
  grainOpacity: number;
  /* brand */
  pine: string;
  pineDeep: string;
  pineBright: string;
  pineTint: string;
  pineTint2: string;
  amber: string;
  amberDeep: string;
  amberTint: string;
  honey: string;
  /* feedback */
  success: string;
  successTint: string;
  warning: string;
  warningTint: string;
  danger: string;
  dangerTint: string;
  info: string;
  infoTint: string;
  /* SRS rating buttons */
  rate: { again: StatePair; hard: StatePair; good: StatePair; easy: StatePair };
  /* card lifecycle states */
  state: {
    new: StatePair;
    learning: StatePair;
    review: StatePair;
    mastered: StatePair;
    due: StatePair;
  };
  /* CEFR levels */
  cefr: { A1: StatePair; A2: StatePair; B1: StatePair; B2: StatePair; C1: StatePair; C2: StatePair };
  /* elevation (RN-adapted from the CSS box-shadows) */
  shadow: {
    xs: ViewStyle;
    sm: ViewStyle;
    md: ViewStyle;
    lg: ViewStyle;
    card: ViewStyle;
  };
}

const warmShadow = (
  opacity: number,
  radius: number,
  height: number,
  elevation: number,
): ViewStyle => ({
  shadowColor: '#322819',
  shadowOpacity: opacity,
  shadowRadius: radius,
  shadowOffset: { width: 0, height },
  elevation,
});

const darkShadow = (
  opacity: number,
  radius: number,
  height: number,
  elevation: number,
): ViewStyle => ({
  shadowColor: '#000000',
  shadowOpacity: opacity,
  shadowRadius: radius,
  shadowOffset: { width: 0, height },
  elevation,
});

export const light: Palette = {
  paper: '#F4F0E7',
  paperSunk: '#ECE6D9',
  surface: '#FBF8F2',
  card: '#FFFFFF',
  cardHover: '#FCFAF4',
  ink: '#211E1A',
  ink2: '#5B554B',
  ink3: '#6C665B',
  inkOnColor: '#FBF8F2',
  inkOnAmber: '#211E1A',
  inkOnDanger: '#FFFFFF',
  hairline: '#E4DDCD',
  hairlineStrong: '#D6CCB6',
  hairlineSoft: '#EFEADF',
  imageWell: '#ECE6D9',
  pageBg: '#E7E0D2',
  tabbarBg: 'rgba(251, 248, 242, 0.92)',
  inverseSurface: '#211E1A',
  inverseText: '#FBF8F2',
  inverseAccent: '#F2B741',
  scrim: 'rgba(33, 30, 26, 0.45)',
  grainOpacity: 0.035,
  pine: '#136F63',
  pineDeep: '#0E574E',
  pineBright: '#1C8A7B',
  pineTint: '#E2EDE9',
  pineTint2: '#D2E4DF',
  amber: '#DD8A2B',
  amberDeep: '#BE7019',
  amberTint: '#FAECD6',
  honey: '#F2B741',
  success: '#2E8B6F',
  successTint: '#DFEFE8',
  warning: '#C77E22',
  warningTint: '#F8EBD4',
  danger: '#AE3A2C',
  dangerTint: '#F6E1DC',
  info: '#2D77B0',
  infoTint: '#DEEAF3',
  rate: {
    again: { fg: '#AE3A2C', tint: '#F6E1DC' },
    hard: { fg: '#C77E22', tint: '#F8EBD4' },
    good: { fg: '#2E8B6F', tint: '#DFEFE8' },
    easy: { fg: '#2D77B0', tint: '#DEEAF3' },
  },
  state: {
    new: { fg: '#2D77B0', tint: '#DEEAF3' },
    learning: { fg: '#DD8A2B', tint: '#FAECD6' },
    review: { fg: '#6A6CC0', tint: '#E6E5F4' },
    mastered: { fg: '#136F63', tint: '#E2EDE9' },
    due: { fg: '#AE3A2C', tint: '#F6E1DC' },
  },
  cefr: {
    A1: { fg: '#4A9D7F', tint: '#E2EFE9' },
    A2: { fg: '#2D9AA6', tint: '#DCEFF1' },
    B1: { fg: '#2D77B0', tint: '#DEEAF3' },
    B2: { fg: '#6A6CC0', tint: '#E6E5F4' },
    C1: { fg: '#B5682A', tint: '#F4E6D5' },
    C2: { fg: '#A8432F', tint: '#F2DFDA' },
  },
  shadow: {
    xs: warmShadow(0.06, 2, 1, 1),
    sm: warmShadow(0.08, 3, 1, 2),
    md: warmShadow(0.08, 12, 4, 4),
    lg: warmShadow(0.12, 28, 12, 8),
    card: warmShadow(0.1, 24, 10, 6),
  },
};

export const dark: Palette = {
  paper: '#1C1916',
  paperSunk: '#151310',
  surface: '#232019',
  card: '#2A251E',
  cardHover: '#322C24',
  ink: '#F1EADD',
  ink2: '#C2B9A7',
  ink3: '#978F7F',
  inkOnColor: '#1C1916',
  inkOnAmber: '#1C1916',
  inkOnDanger: '#1C1916',
  hairline: '#38322A',
  hairlineStrong: '#4A4338',
  hairlineSoft: '#2F2A22',
  imageWell: '#E7E0D2',
  pageBg: '#100E0B',
  tabbarBg: 'rgba(35, 32, 25, 0.9)',
  inverseSurface: '#F1EADD',
  inverseText: '#211E1A',
  inverseAccent: '#146A5E',
  scrim: 'rgba(0, 0, 0, 0.6)',
  grainOpacity: 0.05,
  pine: '#2BA391',
  pineDeep: '#1C8A7B',
  pineBright: '#46BEAA',
  pineTint: '#16332D',
  pineTint2: '#1D423A',
  amber: '#E89A3C',
  amberDeep: '#CF8226',
  amberTint: '#3A2C16',
  honey: '#F2B741',
  success: '#46B093',
  successTint: '#17322A',
  warning: '#DC9A4C',
  warningTint: '#372A16',
  danger: '#E8735F',
  dangerTint: '#3A211C',
  info: '#4F95C9',
  infoTint: '#15293A',
  rate: {
    again: { fg: '#E8735F', tint: '#3A211C' },
    hard: { fg: '#DC9A4C', tint: '#372A16' },
    good: { fg: '#46B093', tint: '#17322A' },
    easy: { fg: '#4F95C9', tint: '#15293A' },
  },
  state: {
    new: { fg: '#4F95C9', tint: '#15293A' },
    learning: { fg: '#E89A3C', tint: '#3A2C16' },
    review: { fg: '#8A8CD6', tint: '#232148' },
    mastered: { fg: '#2BA391', tint: '#16332D' },
    due: { fg: '#E8735F', tint: '#3A211C' },
  },
  cefr: {
    A1: { fg: '#5FB496', tint: '#163029' },
    A2: { fg: '#46B0BC', tint: '#14302F' },
    B1: { fg: '#4F95C9', tint: '#15293A' },
    B2: { fg: '#8A8CD6', tint: '#232148' },
    C1: { fg: '#D08A4C', tint: '#372715' },
    C2: { fg: '#D26B53', tint: '#3A201B' },
  },
  shadow: {
    xs: darkShadow(0.3, 2, 1, 1),
    sm: darkShadow(0.4, 3, 1, 2),
    md: darkShadow(0.45, 12, 4, 4),
    lg: darkShadow(0.55, 28, 12, 8),
    card: darkShadow(0.5, 32, 16, 6),
  },
};

/* ------------------------------------------------------------- structure */

/** 4px base spacing scale (—sp-1 … —sp-16). */
export const sp = {
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
  16: 64,
} as const;

export const radius = {
  xs: 6,
  sm: 10,
  md: 14,
  lg: 20,
  xl: 28,
  pill: 999,
} as const;

/** Modular type scale, ratio 1.25 @ 16px base. */
export const fs = {
  caption: 11,
  small: 13,
  body: 16,
  lead: 20,
  h4: 24,
  h3: 30,
  h2: 38,
  h1: 48,
  display: 60,
} as const;

export const dur = {
  fast: 140,
  normal: 240,
  slow: 400,
} as const;

/* ---------------------------------------------------------------- fonts */

export type FontFamily = 'serif' | 'sans' | 'mono';

/**
 * RN loads each weight as its own fontFamily, so the CSS `font-weight`
 * axis maps to discrete names. Matching follows CSS resolution for static
 * weights (the mock loads 400/500/600/700/800): requests ≥500 resolve
 * upward, so the mock's 650 → 700 and 750 → 800.
 */
const SERIF: Record<number, string> = {
  400: 'Newsreader_400Regular',
  500: 'Newsreader_500Medium',
  600: 'Newsreader_600SemiBold',
  700: 'Newsreader_700Bold',
};
const SERIF_ITALIC: Record<number, string> = {
  400: 'Newsreader_400Regular_Italic',
  500: 'Newsreader_500Medium_Italic',
  600: 'Newsreader_600SemiBold_Italic',
};
const SANS: Record<number, string> = {
  400: 'HankenGrotesk_400Regular',
  500: 'HankenGrotesk_500Medium',
  600: 'HankenGrotesk_600SemiBold',
  700: 'HankenGrotesk_700Bold',
  800: 'HankenGrotesk_800ExtraBold',
};
const MONO: Record<number, string> = {
  400: 'SplineSansMono_400Regular',
  500: 'SplineSansMono_500Medium',
  600: 'SplineSansMono_600SemiBold',
};

function nearest(map: Record<number, string>, weight: number): string {
  const keys = Object.keys(map)
    .map(Number)
    .sort((a, b) => a - b);
  // CSS static-weight resolution for requests ≥ 500: search upward first.
  const up = keys.find((k) => k >= weight);
  return map[up ?? keys[keys.length - 1]];
}

export function font(family: FontFamily, weight = 400, italic = false): TextStyle {
  if (family === 'serif') {
    return { fontFamily: nearest(italic ? SERIF_ITALIC : SERIF, weight) };
  }
  if (family === 'mono') {
    return { fontFamily: nearest(MONO, weight) };
  }
  return { fontFamily: nearest(SANS, weight) };
}

/** Tabular numerals — RN supports fontVariant on both platforms. */
export const tnum: TextStyle = { fontVariant: ['tabular-nums'] };

/* Mockup-ism replaced (WIRING.md §6): TOPPAD/TABH were fixed px in the web
   prototype; the app uses real safe-area insets. TABH remains the design
   height of the bar itself, insets are added at the call site. */
export const TABBAR_HEIGHT = 80;

export const hairlineWidth = Platform.select({ ios: 0.5, default: 1 });
