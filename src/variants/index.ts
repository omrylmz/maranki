/**
 * The content pack of THIS build (spec §9.4), checked at run time.
 *
 * `@variant/pack` is chosen at build time: Metro maps it to
 * `src/variants/${APP_VARIANT ?? 'generic'}/pack.ts` (metro.config.js). The app
 * config says which variant the app was built for: `extra.variant`, written
 * by `app.config.ts` (wave 5). Both come from the same `APP_VARIANT`, but
 * Metro keeps a running server and its cache, so a variant switch without
 * `npx expo start --clear` can bundle the OLD pack into the NEW app. This
 * file catches that:
 *
 *   pack.id === extra.variant   → use the bundled pack;
 *   different, in development   → throw (the red screen names both and the fix);
 *   different, in a release     → log it and use the generic pack (generic
 *                                 copy, no starter decks), never crash.
 *
 * No `extra.variant` (for example a config that does not go through
 * app.config.ts) counts as 'generic'.
 *
 * Screens read `activePack`: AddSheet "Starter decks", onboarding, the Today
 * starter-deck choice, import (card-type presets), the level names on
 * Progress and Complete, and the pack id on the Settings version line.
 */
import { pack as bundledPack } from '@variant/pack';
import Constants from 'expo-constants';

import type { ContentPack } from './types';

export type { CardTypePreset, ContentPack, StarterDeck } from './types';

/**
 * What a release uses after a mismatch: the generic pack's content (no
 * starter decks, no presets, the app's own copy). It is written out here
 * because this file cannot also import './generic/pack': in the generic build
 * (and for the linter, through tsconfig `paths`) that is the same file as
 * `@variant/pack`. pack.test.ts pins that the two are equal.
 */
export const GENERIC_FALLBACK: ContentPack = { id: 'generic', starterDecks: [], cardTypePresets: [] };

/** The variant name of an app config's `extra`: `extra.variant`, or 'generic' when it is missing or blank. */
export function configuredVariant(extra: unknown): string {
  const variant = extra !== null && typeof extra === 'object' ? (extra as { variant?: unknown }).variant : undefined;
  return typeof variant === 'string' && variant.trim() !== '' ? variant.trim() : 'generic';
}

export interface ChoosePackOptions {
  /** true in a development build (`__DEV__`): a mismatch throws. */
  dev: boolean;
  /** The pack a release uses after a mismatch (the generic pack). */
  fallback: ContentPack;
  /** Where a release logs the mismatch. */
  warn: (message: string) => void;
}

/**
 * The pack the app uses: `bundled` when its id is `variant`, else see the
 * top of the file (throw in development, warn + `fallback` in a release).
 *
 *   choosePack(generic, 'generic', …) → generic
 *   choosePack(german,  'generic', { dev: true, … })  → throws
 *   choosePack(german,  'generic', { dev: false, … }) → warns, returns the fallback
 */
export function choosePack(bundled: ContentPack, variant: string, opts: ChoosePackOptions): ContentPack {
  if (bundled.id === variant) return bundled;
  const message =
    `The bundled content pack is "${bundled.id}", but this app was built for the variant "${variant}". ` +
    `Restart Metro with the same APP_VARIANT and a clear cache: APP_VARIANT=${variant} npx expo start --clear`;
  if (opts.dev) throw new Error(message);
  opts.warn(`${message} (Using the generic pack.)`);
  return opts.fallback;
}

/** The content pack of this build, after the check above. */
export const activePack: ContentPack = choosePack(bundledPack, configuredVariant(Constants.expoConfig?.extra), {
  dev: __DEV__,
  fallback: GENERIC_FALLBACK,
  warn: (message) => console.warn(message),
});
