/**
 * The German content pack (spec §9.4, unit W5-1): the build "Maranki German"
 * (`APP_VARIANT=german`, package com.omrylmz.marankide).
 *
 * It is the same app as the generic build. This file only adds CONTENT and
 * COPY: three starter decks, the field presets of their card types, deck
 * defaults, four level names and the onboarding lines. There is no German
 * screen, reducer or filter (the German helpers in src/domain/lang/ work for
 * any German deck, in both builds).
 *
 * How it gets into the app: Metro maps `@variant/pack` to THIS file when
 * APP_VARIANT is 'german' (metro.config.js). Only then are the three `.apkg`
 * files below reachable, so the generic app never contains them.
 *
 * The decks (assets/packs/german/). **They are private and not in this public
 * repo**: to build this variant, copy them into that folder on your own
 * computer (RELEASING.md "The German decks"). CI builds only the generic app:
 *
 *   file                     notes   cards (both directions)   levels   version
 *   German_Vocabulary.apkg   7,517   15,034                     A1–C1    4
 *   German_Grammar.apkg        906      906 (one direction)     A1–B2    2
 *   German_Verbs.apkg          682    1,364                     A1–C2    5
 *                            9,105   17,304
 *
 * Vocabulary version 2 (2026-10-27) is a rebuilt deck with two new fields:
 * `Type` (part of speech, a filter) and `Plural`. Most notes keep the guid of
 * version 1, so an "Update" keeps their progress. The import upgrades the card
 * type in place (plan.ts `upgradeNoteType`), and the dropped notes are retired:
 * kept, their cards suspended, tagged "not in new version" (starterDecks.ts).
 *
 * Vocabulary version 3 (2026-10-29) has ONE example field: `Examples` holds
 * several sentences per word. The field `MarankiExample` (named after this
 * app) is gone, so the deck is not bound to any app. An "Update" removes the
 * field from the card type, except where a note the file does not update still
 * has text in it (a retired note, the learner's own card): then it stays, last
 * and on no side of the card.
 *
 * Vocabulary version 4 (2026-10-30) fixes cards that showed the answer on the
 * question side. Same notes, guids and card type: an "Update" only changes
 * field values.
 *
 * Verbs versions 2 and 3 (2026-10) correct field values. Same notes, guids and
 * card type: an "Update" only changes those values.
 *
 * Verbs version 4 (2026-10-30) changes no note: its templates say
 * {{CaseInfo}} and {{Conjugation}}, not {{{CaseInfo}}} and {{{Conjugation}}}
 * (Anki reads three braces as the field plus a stray "}" on the card). This
 * app reads both forms the same way (roles.ts `TEMPLATE_TAG`), and the
 * planner reuses a card type with the same fields and directions without
 * comparing the template text. So the update from version 3 to version 4
 * changes no note and no card type ("Already up to date."), and the card type
 * keeps its old template text (`TemplateDef.qfmt`/`afmt`).
 *
 * Verbs version 5 (2026-10-30): the EN-DE question shows "Hint: {{CaseInfo}}",
 * and some hints named the verb itself. Only that field changed.
 *
 * Grammar version 2 (2026-10-30) corrects field values. Its card type CSS gains
 * three shared rules; this app does not read Anki CSS, and the planner reuses
 * the card type as it is (same fields and directions).
 *
 * The presets name the REAL card types and fields of these files ("German
 * Vocabulary (bidirectional)", "German Grammar", "German Verbs
 * (bidirectional)"); pack.test.ts checks them against the Anki fixtures
 * (src/domain/__fixtures__/anki/german_*.json: made-up text, but the real
 * card types and fields). A preset is applied to EVERY
 * import with a matching card type name, not only to the starter decks
 * (inferFieldRoles rule 1: presets win): the starter decks pass
 * `pack.cardTypePresets` to suggestMapping (src/domain/starterDecks.ts), and
 * so does the import screen (src/app/import.tsx `startEdits`, through
 * `activePack`). So German_Complete.apkg picked from a file, or a bundled
 * file imported by hand, gets the same roles, labels and languages.
 *
 * The Grammar preset reads the question in ENGLISH (`Question: en-US`): the
 * 906 grammar questions are English sentences, and the card type has no
 * {{tts}} tag that would say so.
 * Without the preset they were read with a German voice (report 3).
 *
 * Bump a starter deck's `version` when its file changes (like the rebuilt
 * vocabulary deck, spec §9.6): the AddSheet then offers "Update {title}
 * (keeps your progress)" to a learner who has the older one. Never change a
 * `key`: it is how a second "Add" finds the deck again (sourceKey
 * 'pack:german:<key>').
 */
import type { FieldDef } from '../../domain/model';
import type { CardTypePreset, ContentPack } from '../types';

// The `require()` of each deck below is an ASSET require: metro.config.js adds
// 'apkg' to Metro's asset extensions, and eslint.config.js adds it to the
// allow list of the `no-require-imports` rule (the same list), so the rule
// stays on here with no change in this file.

/**
 * The presets of one card type, by field name, in a record WITHOUT a
 * prototype. Why: the importer looks a field up by its name
 * (`preset.fields[name]`), and a field may be called "constructor" or
 * "toString"; on a normal object that would find Object's own function.
 * Copied with Object.assign (never spread: a spread gives the prototype back).
 */
function byFieldName(fields: Record<string, Partial<FieldDef>>): CardTypePreset['fields'] {
  return Object.assign(Object.create(null) as CardTypePreset['fields'], fields);
}

export const pack: ContentPack = {
  id: 'german',

  starterDecks: [
    {
      key: 'vocabulary',
      title: 'German vocabulary',
      subtitle: '7,517 words, A1 to C1',
      asset: require('../../../assets/packs/german/German_Vocabulary.apkg'),
      // 2 = the rebuilt deck of 2026-10 (Type and Plural fields); 3 = ONE example field;
      // 4 = no answer on the question side (see the top of the file).
      version: 4,
    },
    {
      key: 'grammar',
      title: 'German grammar',
      subtitle: '906 questions, A1 to B2',
      asset: require('../../../assets/packs/german/German_Grammar.apkg'),
      // 2 = corrected field values (see the top of the file).
      version: 2,
    },
    {
      key: 'verbs',
      title: 'German verbs',
      subtitle: '682 verbs with conjugation, A1 to C2',
      asset: require('../../../assets/packs/german/German_Verbs.apkg'),
      // 2 and 3 = corrected field values; 4 = the same notes, templates without
      // triple braces; 5 = hints that do not name the verb (see the top of the file).
      version: 5,
    },
  ],

  cardTypePresets: [
    {
      // "German Vocabulary (bidirectional)": DE-EN and EN-DE.
      match: /^German Vocabulary/,
      fields: byFieldName({
        Word: { role: 'term', lang: 'de-DE' },
        // Usage notes since version 2 (version 1 had noun plural endings here).
        Grammar: { role: 'detail', label: 'Grammar' },
        VerbForms: { role: 'detail', label: 'Verb forms' },
        // Version 3: several sentences, one per line (the field "MarankiExample"
        // of versions 1 and 2 is gone).
        Examples: { role: 'example', lang: 'de-DE' },
        Translation: { role: 'meaning', lang: 'en-US' },
        Level: { role: 'badge' },
        // Version 2: the part of speech (noun, verb, adjective …). A pill on the
        // card and a filter group in the Library.
        Type: { role: 'badge' },
        // Version 2: the full plural, German text; empty for words without a plural.
        Plural: { role: 'detail', lang: 'de-DE' },
      }),
    },
    {
      // "German Verbs (bidirectional)": DE-EN and EN-DE (the EN-DE question is Meaning + CaseInfo).
      match: /^German Verbs/,
      fields: byFieldName({
        Verb: { role: 'term', lang: 'de-DE' },
        Meaning: { role: 'meaning', lang: 'en-US' },
        CaseInfo: { role: 'detail', label: 'Case / preposition' },
        Conjugation: { role: 'detail' },
        Perfekt: { role: 'detail' },
        Prateritum: { role: 'detail', label: 'Präteritum' },
        Example: { role: 'example', lang: 'de-DE' },
        Level: { role: 'badge' },
        // "irregular, auxiliary": several values in one field.
        Tags: { role: 'badge', multiSep: ',', label: 'Verb type' },
      }),
    },
    {
      // "German Grammar": one direction, an English question.
      match: /^German Grammar/,
      fields: byFieldName({
        Question: { role: 'term', lang: 'en-US' },
        Answer: { role: 'meaning', lang: 'en-US' },
        Example: { role: 'example', lang: 'de-DE' },
        Level: { role: 'badge' },
      }),
    },
  ],

  deckDefaults: { language: 'de-DE', meaningLanguage: 'en-US', genderColors: true, icon: '🇩🇪' },

  // The generic names (spec §8.8) with the fork's four language names back in
  // places 6, 7, 10 and 11.
  levelNames: [
    'Novice',
    'Apprentice',
    'Student',
    'Reader',
    'Scribe',
    'Linguist',
    'Wordsmith',
    'Scholar',
    'Sage',
    'Polyglot',
    'Lexicographer',
    'Luminary',
  ],

  onboarding: {
    tagline: 'Learn German. Keep it.',
    firstChoice: { title: 'Start with German', sub: '9,105 words and grammar, A1 to C2' },
    // "Where do you start?" (A1 … C2) uses the Level field of the three decks.
    placementField: 'Level',
  },
};
