/**
 * The content pack contract (spec §9.4). A build variant ("generic",
 * "german") is the same app with a different CONTENT PACK: starter decks,
 * card-type presets, deck defaults and a few lines of copy. There is no
 * variant-only screen, reducer or filter.
 *
 * Every variant has one pack file, `src/variants/<id>/pack.ts`, that exports
 * `pack: ContentPack`. The app imports it as `@variant/pack`, and the build
 * decides which file that is (an alias, not an `if`):
 *
 *   - Metro (`metro.config.js`): `@variant/pack` → `src/variants/${APP_VARIANT ?? 'generic'}/pack.ts`.
 *     Metro bundles every `require()` it can see, even in a dead `if` branch,
 *     so a runtime `if (variant === 'german') require(...)` would ship the
 *     German decks (about 6 MB) in the generic app. With the alias, only the
 *     chosen pack file and its assets are reachable.
 *   - TypeScript (`tsconfig.json` `paths`) and jest (`moduleNameMapper` in
 *     `package.json`) always see the generic pack.
 *
 * `src/variants/index.ts` checks at run time that the bundled pack is the
 * variant the app was built for (`pack.id === extra.variant`).
 *
 * Types only, no runtime code.
 */
import type { CardTypePreset } from '../domain/roles';

/**
 * A content pack's preset for one card type, matched by the card type's
 * name, e.g. `{ match: /^German Verbs/, fields: { Verb: { role: 'term', lang: 'de-DE' } } }`.
 * The import applies it as rule 1 of `inferFieldRoles` (spec §5.3): preset
 * values win over every guess.
 *
 * The one definition lives in roles.ts (it was written there before this
 * file existed, W2-3); this file re-exports it, so pack files import every
 * pack type from here.
 */
export type { CardTypePreset };

/** One deck file that ships inside the app (spec §9.4 `starterDecks`, §5.10). */
export interface StarterDeck {
  /**
   * Stable key inside the pack, e.g. 'vocabulary'. The deck made from it
   * gets `sourceKey = 'pack:<pack id>:<key>'`, which is how a second "Add"
   * finds that deck again (idempotent add). Never change a key after a
   * release: the decks already made would not be found again.
   */
  key: string;
  /** Row title and the name of a new deck, e.g. "German vocabulary". */
  title: string;
  /** Row subtitle, e.g. "6,845 words, A1 to C1". */
  subtitle: string;
  /**
   * The bundled `.apkg` as a Metro asset module: `require('../../../assets/packs/<id>/<File>.apkg')`.
   * `metro.config.js` adds `apkg` to `assetExts`, so Metro copies the file
   * into the app instead of reading it as code.
   */
  asset: number;
  /**
   * Content version of the bundled file. Bump it when the file changes. The
   * update itself is the same idempotent add: notes are matched by guid and
   * keep their cards and progress; changed field values and tags are
   * updated, new notes are added (and get `source.ref = 'pack:<pack>:<key>@<version>'`).
   *
   * Two limits today (see the top of src/domain/starterDecks.ts):
   *   - NEW fields or directions of a card type are not applied to the
   *     existing notes yet (the import planner's card-type reuse rule);
   *   - the installed version is not recorded in the state yet, so the UI
   *     cannot decide on its own when to offer "Update {title} (keeps your
   *     progress)".
   */
  version: number;
}

/** Everything a build variant adds to the one codebase (spec §9.4). */
export interface ContentPack {
  /** Must equal the `extra.variant` of the app config (checked in src/variants/index.ts). */
  id: 'generic' | 'german';
  /** The decks the pack ships. `[]` for the generic app. */
  starterDecks: StarterDeck[];
  /** Applied by inferFieldRoles rule 1 (spec §5.3) to every import, not only to starter decks. */
  cardTypePresets: CardTypePreset[];
  /** Values a NEW starter deck gets (and the deck editor's defaults, wave 4). */
  deckDefaults?: { language?: string; meaningLanguage?: string; genderColors?: boolean; icon?: string };
  /** Overrides the 12 generic level names (Progress, wave 4). */
  levelNames?: string[];
  /** Onboarding copy (wave 4). `placementField` names the field of "Where do you start?". */
  onboarding?: { tagline?: string; firstChoice?: { title: string; sub: string }; placementField?: string };
}
