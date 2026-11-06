/**
 * The generic content pack (spec §9.4): the default build, "Maranki".
 *
 * It adds nothing: no starter decks (so no `.apkg` is bundled), no card-type
 * presets, and the app's own copy and level names. The app imports this file
 * as `@variant/pack` when `APP_VARIANT` is not set (metro.config.js), and
 * TypeScript and jest always see this file for `@variant/pack`.
 */
import type { ContentPack } from '../types';

export const pack: ContentPack = {
  id: 'generic',
  starterDecks: [],
  cardTypePresets: [],
};
