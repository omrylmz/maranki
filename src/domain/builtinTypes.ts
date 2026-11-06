/**
 * The built-in card types (spec §3.4, "Built-in card types"). A card type
 * ("note type" in Anki) is the list of fields and directions that many cards
 * share.
 *
 * These types are CODE CONSTANTS. A type is written into state the first time
 * a note uses it (`builtinType(kind, now)` builds the object to store). Their
 * ids are STABLE ('nt-basic' …), so code finds them without a lookup table,
 * and two installs or a backup always agree on them.
 *
 * Rules shared by every built-in type:
 *   - `sortField` is 0 (Front / Text / Word).
 *   - Free-text fields have `facet: 'off'`: a small Basic deck must never show
 *     a "Front" or "Back" filter group. Only the legacy Level and Type fields
 *     are filter groups (`facet: 'on'`), so v2.0.2 users get them back.
 *   - `label` is not set, so the UI shows the field name.
 */
import type { FieldDef, Id, NoteType, TemplateDef } from './model';

/** The `NoteType.builtin` values: 'basic' | 'basicReverse' | 'cloze' | 'legacyVocab…'. */
export type BuiltinTypeKind = NonNullable<NoteType['builtin']>;

/** Stable ids, one per kind. Never change them: notes in storage point at them. */
export const BUILTIN_TYPE_IDS: Readonly<Record<BuiltinTypeKind, Id>> = Object.freeze({
  basic: 'nt-basic',
  basicReverse: 'nt-basic-reverse',
  cloze: 'nt-cloze',
  legacyVocabDe: 'nt-legacy-de',
  legacyVocabEs: 'nt-legacy-es',
  legacyVocabFr: 'nt-legacy-fr',
  legacyVocab: 'nt-legacy',
});

/** Every kind, in a fixed order (for pickers and tests). */
export const BUILTIN_TYPE_KINDS: readonly BuiltinTypeKind[] = Object.freeze([
  'basic',
  'basicReverse',
  'cloze',
  'legacyVocabDe',
  'legacyVocabEs',
  'legacyVocabFr',
  'legacyVocab',
]);

/** The kind of a built-in type id, or null when the id is not a built-in one. */
export function builtinKindOf(typeId: Id): BuiltinTypeKind | null {
  for (const kind of BUILTIN_TYPE_KINDS) {
    if (BUILTIN_TYPE_IDS[kind] === typeId) return kind;
  }
  return null;
}

/* ------------------------------------------------------------ field lists */

/** Basic and Basic + reverse: Front (term), Back (meaning), Example (example), Notes (detail). */
function basicFields(): FieldDef[] {
  return [
    { name: 'Front', role: 'term', facet: 'off' },
    { name: 'Back', role: 'meaning', facet: 'off' },
    { name: 'Example', role: 'example', facet: 'off' },
    { name: 'Notes', role: 'detail', facet: 'off' },
  ];
}

/** Ord 0 of Basic: Front on the question side; Back, Example, Notes on the answer side. */
function frontToBack(): TemplateDef {
  return { ord: 0, name: 'Front → Back', prompt: [0], answer: [1, 2, 3] };
}

/**
 * The language of the Word field of each legacy vocabulary type. The plain
 * `legacyVocab` type (any other v0 language) has none: the device voice reads it.
 */
const LEGACY_WORD_LANG: Record<
  'legacyVocabDe' | 'legacyVocabEs' | 'legacyVocabFr' | 'legacyVocab',
  string | undefined
> = {
  legacyVocabDe: 'de-DE',
  legacyVocabEs: 'es-ES',
  legacyVocabFr: 'fr-FR',
  legacyVocab: undefined,
};

/**
 * Legacy vocabulary (v0 cards of v2.0.x and the German fork). The field order
 * is the order of the v2 → v3 mapping (§3.5):
 *   0 Word · 1 Translation · 2 Example · 3 Example translation ·
 *   4 Pronunciation · 5 Level · 6 Type · 7 Article · 8 Base · 9 Notes
 */
function legacyFields(wordLang: string | undefined): FieldDef[] {
  // `lang` is only set when it is known, so a stored FieldDef never carries `lang: undefined`.
  const withLang = (lang: string | undefined) => (lang ? { lang } : {});
  return [
    { name: 'Word', role: 'term', facet: 'off', ...withLang(wordLang) },
    { name: 'Translation', role: 'meaning', facet: 'off', lang: 'en-US' },
    { name: 'Example', role: 'example', facet: 'off', ...withLang(wordLang) },
    { name: 'Example translation', role: 'exampleMeaning', facet: 'off', lang: 'en-US' },
    { name: 'Pronunciation', role: 'pronunciation', facet: 'off' },
    { name: 'Level', role: 'badge', facet: 'on' },
    { name: 'Type', role: 'badge', facet: 'on' },
    { name: 'Article', role: 'hidden', facet: 'off' },
    { name: 'Base', role: 'hidden', facet: 'off' },
    { name: 'Notes', role: 'detail', facet: 'off' },
  ];
}

/** Display names. "Basic" / "Basic + reverse" are the deck-editor copy (§8.10). */
const NAMES: Record<BuiltinTypeKind, string> = {
  basic: 'Basic',
  basicReverse: 'Basic + reverse',
  cloze: 'Cloze',
  legacyVocabDe: 'German words',
  legacyVocabEs: 'Spanish words',
  legacyVocabFr: 'French words',
  legacyVocab: 'Words',
};

/* ---------------------------------------------------------- constructor */

/**
 * Build the NoteType object for a built-in kind, ready to store. `now` sets
 * createdAt/updatedAt. Every call returns NEW arrays and objects, so a caller
 * can never change the constants by accident.
 */
export function builtinType(kind: BuiltinTypeKind, now: number): NoteType {
  const base = {
    id: BUILTIN_TYPE_IDS[kind],
    name: NAMES[kind],
    sortField: 0,
    builtin: kind,
    createdAt: now,
    updatedAt: now,
  };
  switch (kind) {
    case 'basic':
      return { ...base, kind: 'standard', fields: basicFields(), templates: [frontToBack()] };
    case 'basicReverse':
      return {
        ...base,
        kind: 'standard',
        fields: basicFields(),
        templates: [frontToBack(), { ord: 1, name: 'Back → Front', prompt: [1], answer: [0, 2, 3] }],
      };
    case 'cloze':
      // One template; the cards are one per cloze number (ord = number − 1).
      // The prompt shows Text with deletion k hidden; the answer shows Text
      // again with deletion k in bold. renderFace does that from kind 'cloze',
      // so the template lists Text only on the prompt side and Extra (a detail
      // row) on the answer side.
      return {
        ...base,
        kind: 'cloze',
        fields: [
          { name: 'Text', role: 'term', facet: 'off' },
          { name: 'Extra', role: 'detail', facet: 'off' },
        ],
        templates: [{ ord: 0, name: 'Cloze', prompt: [0], answer: [1] }],
      };
    case 'legacyVocabDe':
    case 'legacyVocabEs':
    case 'legacyVocabFr':
    case 'legacyVocab':
      return {
        ...base,
        kind: 'standard',
        fields: legacyFields(LEGACY_WORD_LANG[kind]),
        // Forward: Word + Pronunciation → Translation, Example, Example translation, Notes.
        templates: [{ ord: 0, name: 'Forward', prompt: [0, 4], answer: [1, 2, 3, 9] }],
      };
  }
}
