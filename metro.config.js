/**
 * Metro config (spec §9.4, unit W3-8). Expo's default config plus two things
 * for the build variants:
 *
 * 1. `.apkg` is an ASSET extension. So `require('…/German_Vocabulary.apkg')`
 *    in a pack file gives an asset module (a number for expo-asset), and Metro
 *    copies the file into the app instead of trying to read it as code.
 *
 * 2. The module `@variant/pack` is the pack file of the variant being built:
 *      src/variants/${APP_VARIANT ?? 'generic'}/pack.ts
 *    Why an alias and not `if (variant === 'german') require(...)` in the app:
 *    Metro bundles EVERY `require()` it can see, even one in a dead branch. A
 *    runtime `if` would ship the German decks (about 6 MB) in the generic app.
 *    With the alias, only the chosen pack file, and the assets IT requires,
 *    are reachable.
 *
 * `tsconfig.json` (`paths`) and jest (`moduleNameMapper` in package.json)
 * point `@variant/pack` at the generic pack, for type checks and tests.
 *
 * Switching the variant: stop Metro and start it again with the new
 * APP_VARIANT and a clear cache (`APP_VARIANT=german npx expo start --clear`).
 * src/variants/index.ts checks at run time that the bundled pack matches the
 * app config's `extra.variant`.
 *
 * An APP_VARIANT with no pack file stops here with an error, before anything
 * is bundled (a typo must never build the generic app under another name).
 *
 * How to check this config with the real Metro (the W3-8 notes; the result
 * is the "Metro alias spike" device fact of W0-1, RELEASING.md). jest
 * (src/variants/generic/pack.test.ts) can only run this file with a fake
 * `getDefaultConfig`. Two checks, because they prove different things:
 *
 *   a. No `.apkg` in the generic app:
 *        npx expo export -p android --output-dir <tmp>/export
 *      then `fileMetadata.android.assets[].ext` in <tmp>/export/metadata.json
 *      holds no `apkg` (`find` can't show this: the files have hash names). This does NOT
 *      prove the alias: until wave 4 no screen imports `@variant/pack`
 *      (src/variants/index.ts), so the app bundle never asks Metro for it.
 *
 *   b. The alias: bundle an entry that imports it,
 *        APP_VARIANT=<variant> npx expo export:embed --entry-file src/variants/index.ts \
 *          --platform android --dev true --minify false \
 *          --bundle-output <tmp>/index.js --assets-dest <tmp>/assets
 *      then <tmp>/index.js must contain the module
 *      'src/variants/<variant>/pack.ts' (and no other pack file), and every
 *      `.apkg` that pack requires is in <tmp>/assets/raw/.
 *
 * Results (2026-10-24, generic): (a) 0 of 90 exported files are `.apkg`;
 * (b) the bundle has `src/variants/generic/pack.ts` only. The W3-8 review
 * also ran (b) in a scratch copy with a test pack file at
 * src/variants/german/pack.ts that requires a test `.apkg`: APP_VARIANT=german
 * bundled `src/variants/german/pack.ts`, and the file was copied to
 * assets/raw/. So our `resolveRequest` runs before Expo's tsconfig `paths`
 * resolver (which would always give the generic pack), and `assetExts`
 * works.
 */
const fs = require('fs');
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// 1. Bundled Anki decks are assets.
config.resolver.assetExts.push('apkg');

// 2. `@variant/pack` → the pack file of APP_VARIANT.
const VARIANT_MODULE = '@variant/pack';
const variant = process.env.APP_VARIANT ?? 'generic';
// A plain folder name only: no '/', no '..', no spaces.
if (!/^[a-z][a-z0-9-]*$/.test(variant)) {
  throw new Error(`APP_VARIANT "${variant}" is not a variant name (lower-case letters, digits and '-').`);
}
const packFile = path.join(__dirname, 'src', 'variants', variant, 'pack.ts');
if (!fs.existsSync(packFile)) {
  throw new Error(`Unknown APP_VARIANT "${variant}": ${path.relative(__dirname, packFile)} does not exist.`);
}

// Keep any resolver that was set before (Expo's default sets none), and
// always end in Metro's own resolver, as the Expo docs ask
// (https://docs.expo.dev/guides/customizing-metro/).
const upstreamResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === VARIANT_MODULE) {
    return context.resolveRequest(context, packFile, platform);
  }
  return (upstreamResolveRequest ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
