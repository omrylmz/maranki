/**
 * The generic content pack and the variant plumbing (spec §9.4, unit W3-8).
 *
 * Pinned here:
 *   - the generic pack: id 'generic', no starter decks, no card-type presets,
 *     no copy overrides;
 *   - `@variant/pack` is the generic pack in jest (package.json
 *     `moduleNameMapper`); `npm run typecheck` pins the same for TypeScript
 *     (tsconfig.json `paths`);
 *   - metro.config.js: `apkg` is an asset extension; `@variant/pack` →
 *     src/variants/${APP_VARIANT ?? 'generic'}/pack.ts through Metro's own
 *     resolver; every other module goes to Metro unchanged; an unknown or
 *     bad APP_VARIANT stops the config before anything is bundled;
 *   - no `.apkg` is required outside a non-generic pack folder, so the
 *     generic bundle can never contain one. With the real Metro, the export
 *     check (a) in the header of metro.config.js shows the same; it does
 *     not check the alias (no app module imports `@variant/pack` yet);
 *   - src/variants/index.ts, the run-time check `pack.id === extra.variant`:
 *     same → the pack; different → throws in development, warns and uses the
 *     generic pack in a release; no `extra.variant` → 'generic'.
 */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'fs';
import path from 'path';

import type * as VariantIndex from '../index';
import { choosePack, configuredVariant, GENERIC_FALLBACK } from '../index';
import type { ContentPack } from '../types';
import { pack } from './pack';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(ROOT, 'src');

/* ------------------------------------------------------------ the pack */

describe('the generic pack', () => {
  test('adds nothing: no starter decks, no presets, no copy overrides', () => {
    expect(pack).toEqual({ id: 'generic', starterDecks: [], cardTypePresets: [] });
  });

  test('@variant/pack is the generic pack in jest', () => {
    // Loaded by name (not a second static import of the same file), from the same module registry.
    expect(jest.requireActual<{ pack: ContentPack }>('@variant/pack').pack).toBe(pack);
  });

  test("a release's fallback after a variant mismatch is the generic pack", () => {
    expect(GENERIC_FALLBACK).toEqual(pack);
  });
});

/* --------------------------------------------------------- metro.config.js */

/** The parts of the Metro config this test reads. */
interface MetroConfigLike {
  resolver: {
    assetExts: string[];
    resolveRequest: (context: FakeContext, moduleName: string, platform: string | null) => unknown;
  };
}

interface FakeContext {
  resolveRequest: (context: FakeContext, moduleName: string, platform: string | null) => unknown;
}

const savedVariant = process.env.APP_VARIANT;
afterEach(() => {
  if (savedVariant === undefined) delete process.env.APP_VARIANT;
  else process.env.APP_VARIANT = savedVariant;
});

/**
 * Load metro.config.js afresh with this APP_VARIANT (undefined = not set).
 *
 * Expo's real `getDefaultConfig` cannot load under jest (its dependencies
 * are ES modules for the browser), so it is replaced by a small default
 * config: two asset extensions and, when `upstream` is given, a resolver that
 * was set before ours. The real config and the alias are checked by
 * bundling an entry that imports `@variant/pack` (`npx expo export:embed
 * --entry-file src/variants/index.ts …`, check (b) in the header of
 * metro.config.js). `npx expo export -p android` alone does not check the
 * alias: the app does not import `@variant/pack` yet, so Metro never
 * resolves it there.
 */
function loadMetroConfig(variant: string | undefined, upstream?: FakeContext['resolveRequest']): MetroConfigLike {
  if (variant === undefined) delete process.env.APP_VARIANT;
  else process.env.APP_VARIANT = variant;
  let config: MetroConfigLike | undefined;
  jest.isolateModules(() => {
    jest.doMock('expo/metro-config', () => ({
      getDefaultConfig: (projectRoot: string) => {
        if (projectRoot !== ROOT) throw new Error(`getDefaultConfig(${projectRoot})`);
        return { resolver: { assetExts: ['png', 'jpg'], ...(upstream ? { resolveRequest: upstream } : {}) } };
      },
    }));
    config = jest.requireActual<MetroConfigLike>(path.join(ROOT, 'metro.config.js'));
  });
  return config as MetroConfigLike;
}

/** A Metro resolver context whose own resolver answers with the module name it got. */
function fakeContext(): FakeContext & { calls: [string, string | null][] } {
  const calls: [string, string | null][] = [];
  return {
    calls,
    resolveRequest: (_ctx, moduleName, platform) => {
      calls.push([moduleName, platform]);
      return { type: 'sourceFile', filePath: moduleName };
    },
  };
}

describe('metro.config.js', () => {
  test('apkg is an asset extension (bundled decks are copied, not parsed as code)', () => {
    const config = loadMetroConfig(undefined);
    expect(config.resolver.assetExts).toEqual(['png', 'jpg', 'apkg']); // Expo's defaults are kept
  });

  test.each([undefined, 'generic'])('APP_VARIANT %s: @variant/pack → the generic pack file', (variant) => {
    const config = loadMetroConfig(variant);
    const context = fakeContext();
    const resolved = config.resolver.resolveRequest(context, '@variant/pack', 'android');
    const file = path.join(SRC, 'variants', 'generic', 'pack.ts');
    expect(resolved).toEqual({ type: 'sourceFile', filePath: file });
    // Through Metro's own resolver (it checks the file and the platform).
    expect(context.calls).toEqual([[file, 'android']]);
  });

  test('every other module goes to Metro unchanged', () => {
    const config = loadMetroConfig(undefined);
    const context = fakeContext();
    expect(config.resolver.resolveRequest(context, 'react-native', 'ios')).toEqual({
      type: 'sourceFile',
      filePath: 'react-native',
    });
    expect(config.resolver.resolveRequest(context, '@variant/pack/extra', null)).toEqual({
      type: 'sourceFile',
      filePath: '@variant/pack/extra',
    });
    expect(context.calls).toEqual([
      ['react-native', 'ios'],
      ['@variant/pack/extra', null],
    ]);
  });

  test('a resolver that was set before ours still gets every other module', () => {
    const upstreamCalls: string[] = [];
    const config = loadMetroConfig(undefined, (_ctx, moduleName) => {
      upstreamCalls.push(moduleName);
      return { type: 'empty' };
    });
    const context = fakeContext();
    expect(config.resolver.resolveRequest(context, 'lodash', 'android')).toEqual({ type: 'empty' });
    expect(config.resolver.resolveRequest(context, '@variant/pack', 'android')).toEqual({
      type: 'sourceFile',
      filePath: path.join(SRC, 'variants', 'generic', 'pack.ts'),
    });
    expect(upstreamCalls).toEqual(['lodash']);
  });

  test('an APP_VARIANT without a pack file, or not a plain name, stops the config', () => {
    expect(() => loadMetroConfig('klingon')).toThrow(
      `Unknown APP_VARIANT "klingon": ${path.join('src', 'variants', 'klingon', 'pack.ts')} does not exist.`,
    );
    for (const bad of ['', '../generic', 'Generic', 'ger man', 'generic/../../x']) {
      expect(() => loadMetroConfig(bad)).toThrow('is not a variant name');
    }
  });
});

/* ------------------------------------------- no .apkg in the generic app */

/** Every .ts/.tsx file under `dir`, test files left out (they are never bundled). */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const APKG_IMPORT = /(?:require\s*\(|import\s*\(|from\s+)\s*['"][^'"]*\.apkg['"]/;

/** True when a line of code (not a comment line) requires or imports an .apkg file. */
function requiresApkg(text: string): boolean {
  return text.split('\n').some((line) => {
    const code = line.trim();
    if (code.startsWith('*') || code.startsWith('/*') || code.startsWith('//')) return false;
    return APKG_IMPORT.test(code);
  });
}

describe('no .apkg is reachable from the generic app', () => {
  test('only a non-generic pack folder requires an .apkg file', () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => requiresApkg(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(SRC, file))
      .filter((rel) => {
        const parts = rel.split(path.sep);
        return !(parts[0] === 'variants' && parts.length > 2 && parts[1] !== 'generic');
      });
    expect(offenders).toEqual([]);
  });

  test('the check finds the ways a pack can require a deck, and skips comments', () => {
    expect(requiresApkg("    asset: require('../../../assets/packs/german/German_Verbs.apkg'),")).toBe(true);
    expect(requiresApkg('import deck from "./x.apkg";')).toBe(true);
    expect(requiresApkg("const m = await import('./x.apkg');")).toBe(true);
    expect(requiresApkg("const name = 'German_Verbs.apkg';")).toBe(false);
    expect(requiresApkg(" *   `require('../../../assets/packs/<id>/<File>.apkg')`.")).toBe(false);
    expect(requiresApkg("// asset: require('./x.apkg')")).toBe(false);
  });
});

/* --------------------------------------------------- the run-time check */

const GERMAN: ContentPack = { id: 'german', starterDecks: [], cardTypePresets: [] };

describe('configuredVariant (app config extra.variant)', () => {
  test('the variant, trimmed; missing or blank → generic', () => {
    expect(configuredVariant({ variant: 'german' })).toBe('german');
    expect(configuredVariant({ variant: ' german ' })).toBe('german');
    expect(configuredVariant({ variant: '' })).toBe('generic');
    expect(configuredVariant({ variant: 3 })).toBe('generic');
    expect(configuredVariant({})).toBe('generic');
    expect(configuredVariant(undefined)).toBe('generic');
    expect(configuredVariant(null)).toBe('generic');
  });
});

describe('choosePack (pack.id === extra.variant)', () => {
  test('the same variant → the bundled pack, nothing logged', () => {
    const warn = jest.fn();
    expect(choosePack(GERMAN, 'german', { dev: true, fallback: pack, warn })).toBe(GERMAN);
    expect(choosePack(pack, 'generic', { dev: false, fallback: pack, warn })).toBe(pack);
    expect(warn).not.toHaveBeenCalled();
  });

  test('a different variant throws in development, naming both and the fix', () => {
    expect(() => choosePack(GERMAN, 'generic', { dev: true, fallback: pack, warn: jest.fn() })).toThrow(
      'The bundled content pack is "german", but this app was built for the variant "generic". ' +
        'Restart Metro with the same APP_VARIANT and a clear cache: APP_VARIANT=generic npx expo start --clear',
    );
  });

  test('a different variant in a release: logged, and the generic pack is used', () => {
    const warn = jest.fn();
    expect(choosePack(GERMAN, 'generic', { dev: false, fallback: pack, warn })).toBe(pack);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('(Using the generic pack.)');
  });
});

describe('activePack (src/variants/index.ts with expo-constants)', () => {
  /** Load src/variants/index.ts afresh with this app config `extra`. */
  function loadIndex(extra: unknown): typeof VariantIndex {
    let mod: typeof VariantIndex | undefined;
    jest.isolateModules(() => {
      jest.doMock('expo-constants', () => ({
        __esModule: true,
        default: { expoConfig: extra === undefined ? null : { name: 'Maranki', slug: 'maranki', extra } },
      }));
      mod = jest.requireActual<typeof VariantIndex>('../index');
    });
    return mod as typeof VariantIndex;
  }

  // toEqual, not toBe: each load has its own module registry, so its own copy of the pack object.
  test('the generic build (extra.variant generic, or no app.config.ts yet) → the generic pack', () => {
    expect(loadIndex({ variant: 'generic' }).activePack).toEqual(pack);
    expect(loadIndex({}).activePack).toEqual(pack);
    expect(loadIndex(undefined).activePack).toEqual(pack);
  });

  test('a German app config with the generic bundle throws in development (jest runs as __DEV__)', () => {
    expect(() => loadIndex({ variant: 'german' })).toThrow('The bundled content pack is "generic"');
  });
});
