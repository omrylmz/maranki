/**
 * The built-in card types (spec §3.4). The load-bearing properties:
 *   - the ids are STABLE (stored notes point at them),
 *   - every template only names fields that exist,
 *   - the field lists and directions are exactly the spec table,
 *   - each call returns fresh objects (no shared mutable constants).
 */
import { describe, expect, it } from '@jest/globals';

import {
  BUILTIN_TYPE_IDS,
  BUILTIN_TYPE_KINDS,
  builtinKindOf,
  builtinType,
  type BuiltinTypeKind,
} from './builtinTypes';
import type { NoteType } from './model';

const NOW = 1_700_000_000_000;

/** Field names of a template side, for readable assertions. */
function names(type: NoteType, indexes: number[]): string[] {
  return indexes.map((i) => type.fields[i].name);
}

describe('builtin type ids', () => {
  it('uses the stable ids of the spec', () => {
    expect(BUILTIN_TYPE_IDS).toEqual({
      basic: 'nt-basic',
      basicReverse: 'nt-basic-reverse',
      cloze: 'nt-cloze',
      legacyVocabDe: 'nt-legacy-de',
      legacyVocabEs: 'nt-legacy-es',
      legacyVocabFr: 'nt-legacy-fr',
      legacyVocab: 'nt-legacy',
    });
  });

  it('lists every kind once, and builtinKindOf inverts the ids', () => {
    expect(new Set(BUILTIN_TYPE_KINDS).size).toBe(7);
    expect(new Set(Object.values(BUILTIN_TYPE_IDS)).size).toBe(7);
    for (const kind of BUILTIN_TYPE_KINDS) {
      expect(builtinKindOf(BUILTIN_TYPE_IDS[kind])).toBe(kind);
    }
    expect(builtinKindOf('nt-unknown')).toBeNull();
    expect(builtinKindOf('')).toBeNull();
  });
});

describe('builtinType — shape shared by every kind', () => {
  it.each(BUILTIN_TYPE_KINDS.map((k) => [k]))('%s is a valid NoteType', (kind) => {
    const t = builtinType(kind, NOW);
    expect(t.id).toBe(BUILTIN_TYPE_IDS[kind]);
    expect(t.builtin).toBe(kind);
    expect(t.createdAt).toBe(NOW);
    expect(t.updatedAt).toBe(NOW);
    expect(t.sortField).toBe(0);
    expect(t.name.length).toBeGreaterThan(0);

    // Field names are unique inside a type.
    expect(new Set(t.fields.map((f) => f.name)).size).toBe(t.fields.length);

    // Templates are ordered by ord, 0..n-1, and only name existing fields.
    t.templates.forEach((tpl, i) => {
      expect(tpl.ord).toBe(i);
      for (const idx of [...tpl.prompt, ...tpl.answer]) {
        expect(Number.isInteger(idx)).toBe(true);
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThan(t.fields.length);
      }
      // A field is never on both sides of one template.
      expect(tpl.prompt.filter((i2) => tpl.answer.includes(i2))).toEqual([]);
    });

    // No stored FieldDef carries an explicit `lang: undefined`.
    for (const f of t.fields) {
      expect('lang' in f && f.lang === undefined).toBe(false);
    }
  });

  it('returns fresh objects on every call (constants cannot be changed by accident)', () => {
    const a = builtinType('basicReverse', NOW);
    const b = builtinType('basicReverse', NOW);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(a.fields).not.toBe(b.fields);
    expect(a.fields[0]).not.toBe(b.fields[0]);
    expect(a.templates).not.toBe(b.templates);
    expect(a.templates[0].prompt).not.toBe(b.templates[0].prompt);
  });
});

describe('builtinType — the spec table', () => {
  it('basic: Front (term), Back (meaning), Example (example), Notes (detail); one direction', () => {
    const t = builtinType('basic', NOW);
    expect(t.name).toBe('Basic');
    expect(t.kind).toBe('standard');
    expect(t.fields.map((f) => [f.name, f.role])).toEqual([
      ['Front', 'term'],
      ['Back', 'meaning'],
      ['Example', 'example'],
      ['Notes', 'detail'],
    ]);
    expect(t.templates).toEqual([{ ord: 0, name: 'Front → Back', prompt: [0], answer: [1, 2, 3] }]);
  });

  it('basicReverse: same fields, plus "Back → Front"', () => {
    const t = builtinType('basicReverse', NOW);
    expect(t.name).toBe('Basic + reverse');
    expect(t.fields).toEqual(builtinType('basic', NOW).fields);
    expect(t.templates).toEqual([
      { ord: 0, name: 'Front → Back', prompt: [0], answer: [1, 2, 3] },
      { ord: 1, name: 'Back → Front', prompt: [1], answer: [0, 2, 3] },
    ]);
  });

  it('cloze: Text (term), Extra (detail); one template; kind cloze', () => {
    const t = builtinType('cloze', NOW);
    expect(t.kind).toBe('cloze');
    expect(t.fields.map((f) => [f.name, f.role])).toEqual([
      ['Text', 'term'],
      ['Extra', 'detail'],
    ]);
    expect(t.templates).toHaveLength(1);
    expect(names(t, t.templates[0].prompt)).toEqual(['Text']);
    expect(names(t, t.templates[0].answer)).toEqual(['Extra']);
  });

  it('free-text fields of the basic and cloze types are never filter groups', () => {
    for (const kind of ['basic', 'basicReverse', 'cloze'] as const) {
      expect(builtinType(kind, NOW).fields.every((f) => f.facet === 'off')).toBe(true);
    }
  });

  const legacyCases: [BuiltinTypeKind, string | undefined][] = [
    ['legacyVocabDe', 'de-DE'],
    ['legacyVocabEs', 'es-ES'],
    ['legacyVocabFr', 'fr-FR'],
    ['legacyVocab', undefined],
  ];
  it.each(legacyCases)('%s: the ten legacy fields, roles, languages and "Forward"', (kind, lang) => {
    const t = builtinType(kind, NOW);
    expect(t.kind).toBe('standard');
    expect(t.fields.map((f) => [f.name, f.role])).toEqual([
      ['Word', 'term'],
      ['Translation', 'meaning'],
      ['Example', 'example'],
      ['Example translation', 'exampleMeaning'],
      ['Pronunciation', 'pronunciation'],
      ['Level', 'badge'],
      ['Type', 'badge'],
      ['Article', 'hidden'],
      ['Base', 'hidden'],
      ['Notes', 'detail'],
    ]);
    const byName = new Map(t.fields.map((f) => [f.name, f]));
    // Word and Example share the deck language; the meanings are English.
    expect(byName.get('Word')?.lang).toBe(lang);
    expect(byName.get('Example')?.lang).toBe(lang);
    expect(byName.get('Translation')?.lang).toBe('en-US');
    expect(byName.get('Example translation')?.lang).toBe('en-US');
    // Level and Type come back as filter groups; nothing else is forced.
    expect(t.fields.filter((f) => f.facet === 'on').map((f) => f.name)).toEqual(['Level', 'Type']);

    expect(t.templates).toHaveLength(1);
    const fwd = t.templates[0];
    expect(fwd.name).toBe('Forward');
    expect(names(t, fwd.prompt)).toEqual(['Word', 'Pronunciation']);
    expect(names(t, fwd.answer)).toEqual(['Translation', 'Example', 'Example translation', 'Notes']);
  });
});
