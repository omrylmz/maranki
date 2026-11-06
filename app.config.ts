/**
 * The app config (spec §9.4, unit W5-1): ONE codebase, two build variants.
 *
 *   APP_VARIANT   app name         package / bundle id      scheme       content pack
 *   (not set)     Maranki          com.omrylmz.maranki      maranki      src/variants/generic/pack.ts
 *   generic       Maranki          com.omrylmz.maranki      maranki      src/variants/generic/pack.ts
 *   german        Maranki German   com.omrylmz.marankide    marankide    src/variants/german/pack.ts
 *
 * How Expo reads it (https://docs.expo.dev/workflow/configuration/): the CLI
 * reads app.json first and passes its "expo" object to this function as
 * `config`. app.json is the STATIC BASE (plugins, icons, splash, colours…);
 * this file adds only what differs per variant. So the fields below are NOT
 * in app.json any more: name, slug, scheme, icon, ios.bundleIdentifier and
 * android.package. The function must return the config at once (no Promise).
 *
 * `extra.variant` tells the running app which variant it was built for. The
 * app reads it with expo-constants (src/variants/index.ts) and checks that the
 * content pack Metro bundled is the same one (`pack.id === extra.variant`).
 * Metro picks the pack from the same APP_VARIANT (metro.config.js).
 *
 *   APP_VARIANT=german npx expo start --clear     (npm run start:german)
 *   APP_VARIANT=german npx expo prebuild -p android --clean
 *
 * Switching the variant: always start Metro with `--clear`, and make the
 * native android/ folder again (`expo prebuild --clean`), because the package
 * id is written into it. `npm run android` and `npm run android:german` do
 * the second part for you, and only when android/ was made for the OTHER
 * variant (RELEASING.md "Build variants").
 *
 * The VERSION ("3.0.0") is in app.json and is the same for both variants;
 * the Settings hub shows it with the human app name ("Maranki 3.0.0",
 * "Maranki German 3.0.0", src/components/settings/settingsIndex.ts
 * `appFooterLine`), never the variant id.
 *
 * Both variants use the SAME icon files. The fork's icon was byte-identical
 * to the generic one, so there is no German icon yet (an open design choice,
 * RELEASING.md). `slug` is 'maranki' for both: there is no EAS project to split.
 *
 * An unknown APP_VARIANT stops the build with an error: a typo must never
 * build the generic app under another name.
 */
import type { ConfigContext, ExpoConfig } from 'expo/config';

/** What each variant sets. The keys are the APP_VARIANT values. */
export const VARIANTS = {
  generic: {
    name: 'Maranki',
    slug: 'maranki',
    scheme: 'maranki',
    id: 'com.omrylmz.maranki',
    icon: './assets/images/icon.png',
  },
  german: {
    name: 'Maranki German',
    slug: 'maranki',
    scheme: 'marankide',
    id: 'com.omrylmz.marankide',
    // The generic icon (see the top of the file).
    icon: './assets/images/icon.png',
  },
} as const;

export type VariantId = keyof typeof VARIANTS;

/**
 * The variant named by APP_VARIANT; not set = 'generic'. Throws for any other
 * value. `Object.hasOwn`, not `VARIANTS[name]`: a name like "constructor"
 * would otherwise find Object's own function and pass.
 */
export function variantOf(env: string | undefined): VariantId {
  const name = env ?? 'generic';
  if (!Object.hasOwn(VARIANTS, name)) {
    throw new Error(`Unknown APP_VARIANT "${name}". Use one of: ${Object.keys(VARIANTS).join(', ')}.`);
  }
  return name as VariantId;
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const variant = variantOf(process.env.APP_VARIANT);
  const v = VARIANTS[variant];
  return {
    ...config,
    name: v.name,
    slug: v.slug,
    scheme: v.scheme,
    icon: v.icon,
    ios: { ...config.ios, bundleIdentifier: v.id },
    android: { ...config.android, package: v.id },
    extra: { ...config.extra, variant },
  };
};
