// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

// Expo's `no-require-imports` rule allows `require()` only for the file types
// Metro treats as ASSETS (png, json, ttf …). metro.config.js adds one more
// asset type: '.apkg' (the starter decks a content pack requires,
// src/variants/<id>/pack.ts). So the rule gets the same list + apkg: the
// same rule, the same level, read from Expo's own config (no copy of its list).
const REQUIRE_RULE = '@typescript-eslint/no-require-imports';
const expoRequire = expoConfig.find((c) => c && c.rules && c.rules[REQUIRE_RULE]);
const [requireLevel, requireOptions = {}] = expoRequire.rules[REQUIRE_RULE];

module.exports = defineConfig([
  expoConfig,
  {
    files: expoRequire.files,
    rules: {
      [REQUIRE_RULE]: [requireLevel, { ...requireOptions, allow: [...(requireOptions.allow ?? []), '\\.apkg$'] }],
    },
  },
  {
    ignores: ["dist/*"],
  }
]);
