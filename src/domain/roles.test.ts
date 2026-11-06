/**
 * Templates → directions and roles (spec §5.3, unit W2-3), tested on the
 * real qfmt/afmt strings and notes of the five Anki fixtures. Wave 5b: the
 * card type a new card starts with (newCardTypeId, walkthrough L10), and
 * the deck editor's "Card type", which shows that same type
 * (deckCardTypeChoices, review of L10). Wave 5c: a Basic the learner chose
 * in the deck editor (`defaultTypeChosen`) is a real choice, also in an
 * imported deck.
 */
import { describe, expect, it } from '@jest/globals';

import { type AnkiFixtureName, ankiFixture } from '../test/factories';
import { createRandom } from '../test/random';
import { BUILTIN_TYPE_IDS } from './builtinTypes';
import type { AnkiCollection, FieldDef, Id, Note, NoteType } from './model';
import {
  type CardTypePreset,
  deckCardTypeChoices,
  draftChoices,
  facetRule,
  inferFieldRoles,
  modelFieldNames,
  modelTemplates,
  newCardTypeId,
  parseModelTemplates,
  parseTemplate,
  suggestMapping,
  toTemplateDef,
  type TypeDraft,
} from './roles';

/* ------------------------------------------------------------- helpers */

/** The raw `col.models` JSON of a fixture, as Anki stores it. */
type RawModels = Record<
  string,
  {
    name: string;
    type: number;
    sortf: number;
    flds: { name: string; ord: number }[];
    tmpls: { name: string; ord: number; qfmt: string; afmt: string }[];
  }
>;

/** A fixture as an AnkiCollection (the shape the import reader produces; only what roles.ts reads). */
function fixtureCollection(name: AnkiFixtureName): AnkiCollection {
  const fx = ankiFixture(name);
  const raw = JSON.parse(fx.col.models) as RawModels;
  const models: AnkiCollection['models'] = {};
  for (const [mid, m] of Object.entries(raw)) {
    models[mid] = {
      name: m.name,
      type: m.type === 1 ? 1 : 0,
      sortf: m.sortf,
      flds: m.flds.map((f) => ({ name: f.name, ord: f.ord })),
      tmpls: m.tmpls.map((t) => ({ name: t.name, ord: t.ord, qfmt: t.qfmt, afmt: t.afmt })),
    };
  }
  return {
    fileName: fx.fileName,
    crt: fx.col.crt,
    models,
    decks: {},
    notes: fx.notes.map((n) => ({
      id: String(n.id),
      guid: n.guid,
      mid: String(n.mid),
      flds: n.flds.split('\x1f'),
      tags: n.tags.split(/\s+/).filter((t) => t !== ''),
    })),
    cards: [],
    media: fx.media,
  };
}

/** The draft of the fixture's (only) card type. */
function draftOf(name: AnkiFixtureName, presets: CardTypePreset[] = []): TypeDraft {
  const draft = suggestMapping(fixtureCollection(name), presets);
  expect(draft.types).toHaveLength(1);
  return draft.types[0];
}

/** Field name → role, for compact assertions. */
function rolesOf(fields: FieldDef[]): Record<string, string> {
  return Object.fromEntries(fields.map((f) => [f.name, f.role]));
}

/** Field indexes → field names. */
const namesAt = (draft: TypeDraft, indexes: number[]) => indexes.map((i) => draft.fields[i].name);

/** The only model of a fixture. */
function onlyModel(name: AnkiFixtureName) {
  const models = Object.values(fixtureCollection(name).models);
  expect(models).toHaveLength(1);
  return models[0];
}

/* ------------------------------------------------------------ parseTemplate */

describe('parseTemplate on the real templates', () => {
  it('German Vocabulary DE-EN: {{tts de_DE:Word}} → de-DE; conditionals collect the fields inside', () => {
    const model = onlyModel('german_vocabulary');
    const names = modelFieldNames(model);
    const [deEn, enDe] = parseModelTemplates(model);
    const at = (indexes: number[]) => indexes.map((i) => names[i]);
    // Since version 2 the deck shows the plural and the part of speech ("A1 · noun") on the
    // question; since version 3 it has ONE example field.
    expect(at(deEn.prompt)).toEqual(['Word', 'Plural', 'Grammar', 'Level', 'Type']);
    expect(at(deEn.answer)).toEqual(['Translation', 'VerbForms', 'Examples']);
    expect(deEn.langs).toEqual({ [names.indexOf('Word')]: 'de-DE' });
    expect(at(enDe.prompt)).toEqual(['Translation', 'Level', 'Type']);
    expect(at(enDe.answer)).toEqual(['Word', 'Plural', 'Grammar', 'VerbForms', 'Examples']);
    expect(enDe.langs).toEqual({ [names.indexOf('Word')]: 'de-DE' }); // the tts is on the EN-DE answer side
    expect(deEn.cloze).toBe(false);
    expect(deEn.typeField).toBeUndefined();
  });

  it('German Verbs EN-DE: {{Meaning}} and "Hint: {{CaseInfo}}" are on the prompt', () => {
    const model = onlyModel('german_verbs');
    const names = modelFieldNames(model);
    const enDe = parseModelTemplates(model)[1];
    expect(enDe.prompt.map((i) => names[i])).toEqual(['Meaning', 'CaseInfo', 'Level', 'Tags']);
    expect(enDe.answer.map((i) => names[i])).toEqual(['Verb', 'Conjugation', 'Perfekt', 'Prateritum', 'Example']);
  });

  it('three braces ({{{CaseInfo}}}, German Verbs up to version 3) read like two', () => {
    const names = ['Verb', 'Meaning', 'CaseInfo', 'Conjugation'];
    const three = parseTemplate(
      '{{Meaning}}{{#CaseInfo}}Hint: {{{CaseInfo}}}{{/CaseInfo}}',
      '{{Meaning}}<hr>{{Verb}}{{#CaseInfo}}{{{CaseInfo}}}{{/CaseInfo}}{{{Conjugation}}}',
      names,
    );
    expect(three.prompt).toEqual([1, 2]);
    expect(three.answer).toEqual([0, 3]);
    const two = parseTemplate(
      '{{Meaning}}{{#CaseInfo}}Hint: {{CaseInfo}}{{/CaseInfo}}',
      '{{Meaning}}<hr>{{Verb}}{{#CaseInfo}}{{CaseInfo}}{{/CaseInfo}}{{Conjugation}}',
      names,
    );
    expect(three).toEqual(two);
  });

  it('Spanish: {{tts es_ES:Word}} → es-ES', () => {
    const model = onlyModel('spanish_vocabulary');
    const names = modelFieldNames(model);
    for (const t of parseModelTemplates(model)) expect(t.langs).toEqual({ [names.indexOf('Word')]: 'es-ES' });
  });

  it('{{type:Field}} → typeField (a typing box on the prompt, the comparison on the answer)', () => {
    const t = parseTemplate('{{Front}}<br>{{type:Back}}', '{{FrontSide}}<hr id=answer>{{type:Back}}', ['Front', 'Back']);
    expect(t.typeField).toBe(1);
    expect(t.prompt).toEqual([0]);
    expect(t.answer).toEqual([1]);
    expect(parseTemplate('{{cloze:Text}}{{type:cloze:Text}}', '{{cloze:Text}}', ['Text']).typeField).toBe(0);
  });

  it('{{cloze:Text}} marks a cloze template', () => {
    const t = parseTemplate('{{cloze:Text}}', '{{cloze:Text}}<br>{{Back Extra}}', ['Text', 'Back Extra']);
    expect(t.cloze).toBe(true);
    expect(t.prompt).toEqual([0]);
    expect(t.answer).toEqual([1]);
  });

  it('{{FrontSide}}, static text, unknown names and {{tts}} options are handled', () => {
    const t = parseTemplate(
      'Q: {{text:Front}} {{Tags}} {{Deck}} {{tts en_US voices=Apple_Samantha speed=1.4:Front}}',
      '{{FrontSide}}<hr>{{^Back}}none{{/Back}}{{#Back}}{{ Back }}{{/Back}}',
      ['Front', 'Back'],
    );
    expect(t.prompt).toEqual([0]);
    expect(t.answer).toEqual([1]);
    expect(t.langs).toEqual({ 0: 'en-US' });
  });

  it('a side that ONLY reads fields aloud shows them (a listening card is never blank)', () => {
    // Anki plays the word; Maranki shows it, and the speaker button can read it (lang from the same tag).
    const listening = parseTemplate('{{tts de_DE:Word}}', '{{Word}}<br>{{Meaning}}', ['Word', 'Meaning']);
    expect(listening.prompt).toEqual([0]);
    expect(listening.answer).toEqual([1]);
    expect(listening.langs).toEqual({ 0: 'de-DE' });
    // The same on the answer side.
    const spokenAnswer = parseTemplate('{{Meaning}}', '{{FrontSide}}<hr>{{tts de_DE:Word}}', ['Word', 'Meaning']);
    expect(spokenAnswer.prompt).toEqual([1]);
    expect(spokenAnswer.answer).toEqual([0]);
    // A side that shows a field keeps {{tts}} as read-aloud only (not shown).
    const both = parseTemplate('{{Front}} {{tts en_US:Back}}', '{{Back}}', ['Front', 'Back']);
    expect(both.prompt).toEqual([0]);
    expect(both.answer).toEqual([1]);
    // `spoken` keeps every field the question side reads aloud.
    expect(listening.spoken).toEqual([0]);
    expect(both.spoken).toEqual([1]);
    expect(spokenAnswer.spoken).toEqual([]); // the {{tts}} is on the answer side
  });

  it('a dictation card never shows the field it types (the question stays empty)', () => {
    // Anki's "listen, then type the word": showing Word above the typing box would show the answer.
    const names = ['Word', 'Meaning'];
    const dictation = parseTemplate('{{tts de_DE:Word}}{{type:Word}}', '{{Word}}<br>{{Meaning}}', names);
    expect(dictation.prompt).not.toContain(0);
    expect(dictation.prompt).toEqual([]);
    expect(dictation.typeField).toBe(0);
    expect(dictation.langs).toEqual({ 0: 'de-DE' });
    expect(dictation.answer).toEqual([0, 1]); // the revealed side shows the word and its meaning
    expect(dictation.spoken).toEqual([0]);
    // Anki's usual answer side ({{type:Word}} = the comparison) shows Word on the answer too.
    const usual = parseTemplate('{{tts de_DE:Word}}{{type:Word}}', '{{FrontSide}}<hr id=answer>{{type:Word}}<br>{{Meaning}}', names);
    expect(usual).toMatchObject({ prompt: [], answer: [0, 1], typeField: 0 });
    // The typing field from the answer side is not shown on the question either.
    expect(parseTemplate('{{tts de_DE:Word}}', '{{type:Word}}<br>{{Meaning}}', names)).toMatchObject({ prompt: [], typeField: 0 });
    // Another read-aloud field is still shown: only the typed one is left out.
    expect(parseTemplate('{{tts de_DE:Word}}{{tts en_US:Meaning}}{{type:Word}}', '{{Word}}', names).prompt).toEqual([1]);
  });

  it('a field only inside a condition marker (not shown) is not collected', () => {
    const t = parseTemplate('{{#Hint}}has hint{{/Hint}}{{Front}}', '{{Back}}', ['Front', 'Back', 'Hint']);
    expect(t.prompt).toEqual([0]);
    expect(t.answer).toEqual([1]);
  });

  it('field names match exactly first, then without case', () => {
    expect(parseTemplate('{{word}}', '', ['Word']).prompt).toEqual([0]);
    expect(parseTemplate('{{word}}', '', ['Word', 'word']).prompt).toEqual([1]);
  });

  it('toTemplateDef leaves badges out of both sides and keeps qfmt/afmt', () => {
    const model = onlyModel('german_verbs');
    const draft = draftOf('german_verbs');
    const enDe = toTemplateDef(parseModelTemplates(model)[1], draft.fields, {
      ord: 1,
      name: 'EN-DE',
      qfmt: model.tmpls[1].qfmt,
      afmt: model.tmpls[1].afmt,
    });
    expect(namesAt(draft, enDe.prompt)).toEqual(['Meaning', 'CaseInfo']);
    expect(namesAt(draft, enDe.answer)).toEqual(['Verb', 'Conjugation', 'Perfekt', 'Prateritum', 'Example']);
    expect(enDe.qfmt).toBe(model.tmpls[1].qfmt);
    expect(enDe.afmt).toBe(model.tmpls[1].afmt);
  });
});

/* ------------------------------------------------------------- facetRule */

describe('facetRule (the data rule of §4.3, plus "values repeat")', () => {
  const repeat = (values: string[], times: number) => Array.from({ length: times }, () => values).flat();

  it('passes few, short, repeating values filled in ≥ 50% of the notes', () => {
    expect(facetRule(repeat(['A1', 'A2', 'B1'], 5))).toEqual({ pass: true });
    expect(facetRule([...repeat(['A1', 'B1'], 3), '', '', '', '', '', ''])).toEqual({ pass: true }); // exactly 50%
  });

  it('fails when less than half of the notes have a value', () => {
    expect(facetRule([...repeat(['A1', 'B1'], 3), '', '', '', '', '', '', ''])).toEqual({ pass: false });
  });

  it('fails above 24 values, or with a value over 40 characters', () => {
    const many = Array.from({ length: 25 }, (_, i) => `v${i}`);
    expect(facetRule(repeat(many, 3))).toEqual({ pass: false });
    expect(facetRule(repeat(['short', 'x'.repeat(41)], 4))).toEqual({ pass: false });
  });

  it('fails when the values do not repeat (every word of a small deck is different)', () => {
    expect(facetRule(['Haus', 'Baum', 'Katze', 'Hund'])).toEqual({ pass: false });
  });

  it('folds values: HTML, case and accents do not make new values', () => {
    expect(facetRule(['<b>Noun</b>', 'noun', 'NOUN ', 'Verb', 'verb', 'vérb'])).toEqual({ pass: true });
  });

  it('finds a multi-value field and its separator', () => {
    const tags = repeat(['regular, separable', 'irregular, mixed', 'regular, inseparable, reflexive', 'regular'], 3);
    // 4 raw values repeat too, so make the raw values unique per note but the tokens few:
    const unique = Array.from({ length: 30 }, (_, i) => ['regular', 'irregular', 'separable', 'mixed'].slice(0, 2 + (i % 3)).join(', ') + (i % 2 ? ', modal' : '') + `, t${i % 5}`);
    expect(facetRule(tags)).toEqual({ pass: true });
    expect(facetRule(unique)).toEqual({ pass: true, multiSep: ',' });
    expect(facetRule(unique.map((v) => v.replace(/, /g, '; ')))).toEqual({ pass: true, multiSep: ';' });
  });

  it('an empty list passes nothing', () => {
    expect(facetRule([])).toEqual({ pass: false });
  });
});

/* -------------------------------------------------------- inferFieldRoles */

describe('inferFieldRoles on the five deck fixtures', () => {
  it('German Vocabulary: Level and Type badges, Word term (de-DE), Translation meaning, Examples', () => {
    const d = draftOf('german_vocabulary');
    expect(rolesOf(d.fields)).toEqual({
      Word: 'term',
      Grammar: 'detail',
      VerbForms: 'detail',
      Examples: 'example',
      Translation: 'meaning',
      Level: 'badge',
      // Since version 2 the part of speech is a badge by its data (a filter group),
      // with no pack preset; the plural is a labelled row.
      Type: 'badge',
      Plural: 'detail',
    });
    expect(d.fields.find((f) => f.name === 'Word')?.lang).toBe('de-DE');
    expect(d.fields.find((f) => f.name === 'Level')?.facet).toBe('auto');
    expect(d.fields.find((f) => f.name === 'Type')?.facet).toBe('auto');
    expect(d.fields.find((f) => f.name === 'Word')?.facet).toBe('off');
    // Version 2 still had "MarankiExample": the compound name matches as an example.
    expect(rolesOf(draftOf('german_vocabulary_v2').fields).MarankiExample).toBe('example');
  });

  it('German Verbs: Level badge, Tags multi-value badge, Verb term, Meaning meaning', () => {
    const d = draftOf('german_verbs');
    expect(rolesOf(d.fields)).toEqual({
      Verb: 'term',
      Meaning: 'meaning',
      CaseInfo: 'detail',
      Conjugation: 'detail',
      Perfekt: 'detail',
      Prateritum: 'detail',
      Example: 'example',
      Level: 'badge',
      Tags: 'badge',
    });
    expect(d.fields.find((f) => f.name === 'Tags')?.multiSep).toBe(',');
    expect(d.fields.find((f) => f.name === 'Verb')?.lang).toBe('de-DE');
  });

  it('German Grammar: Level badge, Question term, Answer meaning, Example example', () => {
    expect(rolesOf(draftOf('german_grammar').fields)).toEqual({
      Question: 'term',
      Answer: 'meaning',
      Example: 'example',
      Level: 'badge',
    });
  });

  it('Spanish: Level and Type badges, Pronunciation, Word term (es-ES), Translation meaning', () => {
    const d = draftOf('spanish_vocabulary');
    expect(rolesOf(d.fields)).toEqual({
      Word: 'term',
      Translation: 'meaning',
      Example: 'example',
      Pronunciation: 'pronunciation',
      Type: 'badge',
      Level: 'badge',
    });
    expect(d.fields.find((f) => f.name === 'Word')?.lang).toBe('es-ES');
  });

  it('Algo Deck: Category badge, Front term, Back meaning', () => {
    expect(rolesOf(draftOf('algo_patterns').fields)).toEqual({
      Front: 'term',
      Back: 'meaning',
      Category: 'badge',
    });
  });
});

describe('inferFieldRoles rules', () => {
  const parsed = (q: string, a: string, names: string[]) => parseTemplate(q, a, names);

  it('rule 3: pronunciation by IPA-looking values, even with an unknown name', () => {
    const names = ['Word', 'Sound', 'Meaning'];
    const notes = [
      ['Haus', '/haʊs/', 'house'],
      ['Baum', '[baʊm]', 'tree'],
      ['Stunde', 'ˈʃtʊndə', 'hour'],
      ['Katze', 'katze', 'cat'],
    ];
    const roles = inferFieldRoles({ name: 'X', fieldNames: names, templates: [parsed('{{Word}}', '{{Meaning}}', names)] }, notes);
    expect(roles.map((f) => f.role)).toEqual(['term', 'pronunciation', 'meaning']);
  });

  it('rule 3 by name: "IPA" as a word, but not inside "Principal"', () => {
    const names = ['Front', 'Back', 'IPA', 'Principal'];
    const notes = [['a', 'b', 'x', 'p1'], ['c', 'd', 'y', 'p2']];
    const roles = inferFieldRoles({ name: 'X', fieldNames: names, templates: [] }, notes);
    expect(roles.map((f) => f.role)).toEqual(['term', 'meaning', 'pronunciation', 'detail']);
  });

  it('rule 6 before rule 5: "Example translation" is exampleMeaning, not meaning', () => {
    const names = ['Word', 'Translation', 'Example', 'Example translation', 'ExampleEN'];
    const notes = [['a', 'b', 'c', 'd', 'e'], ['f', 'g', 'h', 'i', 'j']];
    const roles = inferFieldRoles({ name: 'X', fieldNames: names, templates: [] }, notes);
    expect(roles.map((f) => f.role)).toEqual(['term', 'meaning', 'example', 'exampleMeaning', 'exampleMeaning']);
  });

  it('rule 5 prefers the most-filled field when two names match (the old importer took the first, even empty)', () => {
    const names = ['Term', 'Word', 'Translation'];
    const notes = [
      ['', 'Haus', 'house'],
      ['', 'Baum', 'tree'],
      ['Katze', 'Katze', 'cat'],
    ];
    const roles = inferFieldRoles({ name: 'X', fieldNames: names, templates: [] }, notes);
    expect(roles.map((f) => f.role)).toEqual(['detail', 'term', 'meaning']);
  });

  it('rule 4: the reverse template only gives a meaning when its first field is not the term', () => {
    const names = ['Word', 'Audio', 'Info'];
    const notes = [['a', 'x', 'm1'], ['b', 'y', 'm2']];
    const templates = [parsed('{{Word}}', '{{Info}}', names), parsed('{{Word}}{{Audio}}', '{{Info}}', names)];
    const roles = inferFieldRoles({ name: 'X', fieldNames: names, templates }, notes);
    // ord 1 starts with the term too, so it is not a reverse template: Audio is NOT the meaning.
    // Info (the first answer field of ord 0) gets it from the positional fallback (7a).
    expect(roles.map((f) => f.role)).toEqual(['term', 'detail', 'meaning']);
  });

  it('rule 7a: unknown names still give a Front and a Back, by position (as the old importer)', () => {
    const names = ['Deutsch', 'Notiz', 'Englisch'];
    const notes = [['Haus', '', 'house'], ['Baum', '', 'tree']];
    const roles = inferFieldRoles({ name: 'X', fieldNames: names, templates: [] }, notes);
    // Notiz is empty everywhere, so the meaning is the next field WITH values.
    expect(roles.map((f) => f.role)).toEqual(['term', 'detail', 'meaning']);
  });

  it('presets win (rule 1), and their label/lang/facet/multiSep are kept', () => {
    const grammarPreset: CardTypePreset = {
      match: /^German Grammar/,
      fields: {
        Question: { role: 'term', lang: 'en-US' },
        Answer: { role: 'meaning', lang: 'en_US' },
        Example: { role: 'example', lang: 'de-DE' },
        Level: { role: 'badge' },
      },
    };
    const d = draftOf('german_grammar', [grammarPreset]);
    expect(d.fields).toEqual([
      { name: 'Question', role: 'term', facet: 'off', lang: 'en-US' },
      { name: 'Answer', role: 'meaning', facet: 'off', lang: 'en-US' },
      { name: 'Example', role: 'example', facet: 'off', lang: 'de-DE' },
      { name: 'Level', role: 'badge', facet: 'auto' },
    ]);

    const verbsPreset: CardTypePreset = {
      match: /^German Verbs/g, // a /g regex must not break matching (lastIndex)
      fields: {
        CaseInfo: { role: 'detail', label: 'Case / preposition' },
        Tags: { role: 'badge', multiSep: ',', label: 'Verb type' },
        Perfekt: { role: 'hidden' },
        Example: { label: 'Beispiel' },
      },
    };
    for (let k = 0; k < 2; k++) {
      const v = draftOf('german_verbs', [verbsPreset]);
      const byName = Object.fromEntries(v.fields.map((f) => [f.name, f]));
      expect(byName.CaseInfo).toEqual({ name: 'CaseInfo', role: 'detail', facet: 'auto', label: 'Case / preposition' });
      expect(byName.Tags).toEqual({ name: 'Tags', role: 'badge', facet: 'auto', multiSep: ',', label: 'Verb type' });
      expect(byName.Perfekt.role).toBe('hidden');
      expect(byName.Example).toEqual({ name: 'Example', role: 'example', facet: 'off', label: 'Beispiel' });
    }
  });

  it('a preset that makes a field a term stops rule 4 from making a second term', () => {
    const preset: CardTypePreset = { match: /^Coding/, fields: { Back: { role: 'term' } } };
    const names = ['Front', 'Back'];
    const notes = [['q1', 'a1'], ['q2', 'a2']];
    const roles = inferFieldRoles(
      { name: 'Coding', fieldNames: names, templates: [parsed('{{Front}}', '{{Back}}', names)] },
      notes,
      [preset],
    );
    // Front cannot be a second term; it becomes the meaning by position (7a).
    expect(roles.map((f) => f.role)).toEqual(['meaning', 'term']);
  });

  it('rule 7a: a one-direction EN → DE deck gets its ANSWER field as Back, never a question-side hint', () => {
    // The question shows Meaning and "Hint: CaseInfo" (filled in only some notes, so
    // not a pill), the answer shows Verb. No name tells the roles apart: positions decide.
    const names = ['Verb', 'Meaning', 'CaseInfo', 'Example'];
    const notes = Array.from({ length: 10 }, (_, k) => [
      `verb${k}`,
      `to do ${k}`,
      k < 4 ? `+ Akk ${k}` : '',
      `Satz ${k}.`,
    ]);
    const roles = inferFieldRoles(
      {
        name: 'Sample verbs (one direction)',
        fieldNames: names,
        templates: [
          parsed(
            '{{Meaning}}{{#CaseInfo}}<div>Hint: {{CaseInfo}}</div>{{/CaseInfo}}',
            '{{FrontSide}}<hr id=answer>{{Verb}}<div>{{Example}}</div>',
            names,
          ),
        ],
      },
      notes,
    );
    expect(Object.fromEntries(roles.map((f) => [f.name, f.role]))).toEqual({
      Verb: 'meaning',
      Meaning: 'term',
      CaseInfo: 'detail',
      Example: 'example',
    });
  });
});

/* --------------------------------------------- rule 2: safe as a pill only */

/** Anki's own stock note types, with their real templates. */
const STOCK = {
  basic: {
    name: 'Basic',
    fields: ['Front', 'Back'],
    tmpls: [{ name: 'Card 1', qfmt: '{{Front}}', afmt: '{{FrontSide}}\n\n<hr id=answer>\n\n{{Back}}' }],
  },
  reversed: {
    name: 'Basic (and reversed card)',
    fields: ['Front', 'Back'],
    tmpls: [
      { name: 'Card 1', qfmt: '{{Front}}', afmt: '{{FrontSide}}\n\n<hr id=answer>\n\n{{Back}}' },
      { name: 'Card 2', qfmt: '{{Back}}', afmt: '{{FrontSide}}\n\n<hr id=answer>\n\n{{Front}}' },
    ],
  },
  optionalReversed: {
    name: 'Basic (optional reversed card)',
    fields: ['Front', 'Back', 'Add Reverse'],
    tmpls: [
      { name: 'Card 1', qfmt: '{{Front}}', afmt: '{{FrontSide}}\n\n<hr id=answer>\n\n{{Back}}' },
      {
        name: 'Card 2',
        qfmt: '{{#Add Reverse}}{{Back}}{{/Add Reverse}}',
        afmt: '{{FrontSide}}\n\n<hr id=answer>\n\n{{Front}}',
      },
    ],
  },
  typeIn: {
    name: 'Basic (type in the answer)',
    fields: ['Front', 'Back'],
    tmpls: [
      { name: 'Card 1', qfmt: '{{Front}}\n\n{{type:Back}}', afmt: '{{Front}}\n\n<hr id=answer>\n\n{{type:Back}}' },
    ],
  },
} as const;

/** A one-type collection from a stock note type and rows of field values. */
function stockCollection(stock: (typeof STOCK)[keyof typeof STOCK], rows: string[][]): AnkiCollection {
  return {
    fileName: 'stock.apkg',
    crt: 0,
    models: {
      '1': {
        name: stock.name,
        type: 0,
        sortf: 0,
        flds: stock.fields.map((name, ord) => ({ name, ord })),
        tmpls: stock.tmpls.map((t, ord) => ({ ...t, ord })),
      },
    },
    decks: {},
    notes: rows.map((flds, i) => ({ id: `n${i}`, guid: `g${i}`, mid: '1', flds, tags: [] })),
    cards: [],
    media: {},
  };
}

const NOUNS = ['Haus', 'Baum', 'Katze', 'Hund', 'Tisch', 'Auto', 'Buch', 'Lampe', 'Tür', 'Stuhl'];
/** Answers with few, repeating values: they pass the facet rule, but they ARE the answer. */
const FEW_ANSWERS: [string, string[]][] = [
  ['der/die/das', ['das', 'der', 'die', 'der', 'der', 'das', 'das', 'die', 'die', 'der']],
  ['A–D (multiple choice)', ['A', 'B', 'C', 'D', 'A', 'B', 'C', 'D', 'A', 'B']],
  ['True/False', ['True', 'False', 'True', 'True', 'False', 'False', 'True', 'False', 'True', 'False']],
];

describe('rule 2: only a field that is safe as a pill becomes a badge', () => {
  it.each(FEW_ANSWERS)('Basic with Back = %s: Back is the meaning, and both sides have a field', (_label, backs) => {
    const d = suggestMapping(stockCollection(STOCK.basic, NOUNS.map((w, i) => [w, backs[i]]))).types[0];
    expect(rolesOf(d.fields)).toEqual({ Front: 'term', Back: 'meaning' });
    expect(namesAt(d, d.templates[0].prompt)).toEqual(['Front']);
    expect(namesAt(d, d.templates[0].answer)).toEqual(['Back']);
  });

  it.each(FEW_ANSWERS)('Basic (and reversed card) with Back = %s: the reverse card asks Back (no blank question)', (_label, backs) => {
    const d = suggestMapping(stockCollection(STOCK.reversed, NOUNS.map((w, i) => [w, backs[i]]))).types[0];
    expect(rolesOf(d.fields)).toEqual({ Front: 'term', Back: 'meaning' });
    expect(d.templates.map((t) => [namesAt(d, t.prompt), namesAt(d, t.answer)])).toEqual([
      [['Front'], ['Back']],
      [['Back'], ['Front']],
    ]);
  });

  it('Basic (optional reversed card): "Add Reverse" is only a condition, so it is never a badge', () => {
    const rows = NOUNS.map((w, i) => [w, FEW_ANSWERS[0][1][i], i < 7 ? 'y' : '']); // 'y' in 70% of the notes
    const d = suggestMapping(stockCollection(STOCK.optionalReversed, rows)).types[0];
    expect(rolesOf(d.fields)).toEqual({ Front: 'term', Back: 'meaning', 'Add Reverse': 'detail' });
    // It is on no side of any direction.
    for (const t of d.templates) expect([...t.prompt, ...t.answer]).not.toContain(2);
  });

  it('Basic (type in the answer) with True/False: Back is the typed answer, not a badge', () => {
    const d = suggestMapping(stockCollection(STOCK.typeIn, NOUNS.map((w, i) => [w, FEW_ANSWERS[2][1][i]]))).types[0];
    expect(rolesOf(d.fields)).toEqual({ Front: 'term', Back: 'meaning' });
    expect(d.templates[0]).toMatchObject({ prompt: [0], answer: [1], typeField: 1 });
  });

  it('a question side never loses ALL its fields to badges: the most varied one stays a normal field', () => {
    const names = ['Category', 'Front', 'Back'];
    const t = parseTemplate('{{Category}}{{Front}}', '{{FrontSide}}<hr>{{Back}}', names);
    // Homonyms repeat the Front (3 values), and Category repeats too (2 values): both pass the facet rule.
    const notes = [
      ['x', 'bank', 'river side'],
      ['x', 'bank', 'money place'],
      ['x', 'set', 'to put'],
      ['y', 'set', 'a group'],
      ['y', 'run', 'to go fast'],
      ['y', 'run', 'a series'],
    ];
    const roles = inferFieldRoles({ name: 'X', fieldNames: names, templates: [t] }, notes);
    expect(roles.map((f) => f.role)).toEqual(['badge', 'term', 'meaning']);
    // With only the repeating Front on the question side, the Front is the term (never a pill).
    const alone = parseTemplate('{{Front}}', '{{Back}}', ['Front', 'Back']);
    const front = inferFieldRoles({ name: 'X', fieldNames: ['Front', 'Back'], templates: [alone] }, notes.map((r) => r.slice(1)));
    expect(front.map((f) => f.role)).toEqual(['term', 'meaning']);
  });

  it('a badge that is also read aloud still goes back to a normal field (reading it would show a pill)', () => {
    // Same homonym notes as above, but the question also reads the Front aloud. Front is a badge
    // too, so the read-aloud field cannot be asked: the most varied badge is still un-badged.
    const names = ['Category', 'Front', 'Back'];
    const t = parseTemplate('{{Category}}{{Front}}{{tts en_US:Front}}', '{{FrontSide}}<hr>{{Back}}', names);
    const notes = [
      ['x', 'bank', 'river side'],
      ['x', 'bank', 'money place'],
      ['x', 'set', 'to put'],
      ['y', 'set', 'a group'],
      ['y', 'run', 'to go fast'],
      ['y', 'run', 'a series'],
    ];
    const roles = inferFieldRoles({ name: 'X', fieldNames: names, templates: [t] }, notes);
    expect(roles.map((f) => f.role)).toEqual(['badge', 'term', 'meaning']);
  });

  it('a preset badge stays a badge, even when it is the only question field (presets win)', () => {
    const names = ['Front', 'Back'];
    const t = parseTemplate('{{Front}}', '{{Back}}', names);
    const preset: CardTypePreset = { match: /^X$/, fields: { Front: { role: 'badge' } } };
    const roles = inferFieldRoles({ name: 'X', fieldNames: names, templates: [t] }, [['a', 'b'], ['c', 'd']], [preset]);
    expect(roles[0].role).toBe('badge');
  });

  it('without templates (a CSV): a Front/Back name never becomes a badge; two normal fields with values are kept', () => {
    const trueFalse = FEW_ANSWERS[2][1];
    const qa = inferFieldRoles(
      { name: 'quiz.csv', fieldNames: ['Question', 'Answer'], templates: [] },
      NOUNS.map((w, i) => [`Is ${w} a noun?`, trueFalse[i]]),
    );
    expect(qa.map((f) => f.role)).toEqual(['term', 'meaning']);

    // Unknown names: "Artikel" passes the facet rule, but then there would be no Back.
    const gender = inferFieldRoles(
      { name: 'gender.csv', fieldNames: ['Deutsch', 'Artikel'], templates: [] },
      NOUNS.map((w, i) => [w, FEW_ANSWERS[0][1][i]]),
    );
    expect(gender.map((f) => f.role)).toEqual(['term', 'meaning']);

    // A real filter column is still a badge: Word and Translation stay the Front and the Back.
    const levels = ['A1', 'A2', 'B1', 'A1', 'A2', 'B1', 'A1', 'A2', 'B1', 'A1'];
    const vocab = inferFieldRoles(
      { name: 'vocab.csv', fieldNames: ['Word', 'Translation', 'Level'], templates: [] },
      NOUNS.map((w, i) => [w, `meaning ${i}`, levels[i]]),
    );
    expect(vocab.map((f) => f.role)).toEqual(['term', 'meaning', 'badge']);
  });
});

/* ------------------------------------ listening and dictation questions */

describe('listening and dictation questions ({{tts}} on the question side)', () => {
  /** A one-type collection: fields Word, Meaning, Level; four notes with two levels (Level passes the facet rule). */
  const vocab = (tmpls: { name: string; qfmt: string; afmt: string }[]): AnkiCollection => ({
    fileName: 'listen.apkg',
    crt: 0,
    models: {
      '3': {
        name: 'Listening',
        type: 0,
        sortf: 0,
        flds: ['Word', 'Meaning', 'Level'].map((name, ord) => ({ name, ord })),
        tmpls: tmpls.map((t, ord) => ({ ...t, ord })),
      },
    },
    decks: {},
    notes: [
      ['die Stunde', 'the hour', 'A1'],
      ['der Tag', 'the day', 'A1'],
      ['das Haus', 'the house', 'A2'],
      ['der Baum', 'the tree', 'A2'],
    ].map((flds, i) => ({ id: `l${i}`, guid: `gl${i}`, mid: '3', flds, tags: [] })),
    cards: [],
    media: {},
  });
  /** The real German decks put the level above the word (see the fixtures' qfmt). */
  const LEVEL = '<div class="level">{{Level}}</div>';
  const ANSWER = '{{FrontSide}}<hr>{{Word}}<br>{{Meaning}}';

  it('a listening question that also shows a Level pill asks the word it reads aloud; Level stays a badge', () => {
    const d = suggestMapping(vocab([{ name: 'Listen', qfmt: `${LEVEL}{{tts de_DE:Word}}`, afmt: ANSWER }])).types[0];
    expect(rolesOf(d.fields)).toEqual({ Word: 'term', Meaning: 'meaning', Level: 'badge' });
    expect(namesAt(d, d.templates[0].prompt)).toEqual(['Word']);
    expect(namesAt(d, d.templates[0].answer)).toEqual(['Meaning']);
    expect(d.fields[0].lang).toBe('de-DE');
    expect(d.templates[0].typeField).toBeUndefined();
  });

  it('a dictation question never asks its typing field: Word is typed, not shown', () => {
    const d = suggestMapping(
      vocab([{ name: 'Dictation', qfmt: '{{tts de_DE:Word}}{{type:Word}}', afmt: '{{Word}}<br>{{Meaning}}' }]),
    ).types[0];
    expect(d.templates[0]).toMatchObject({ prompt: [], answer: [0, 1], typeField: 0 });
    expect(rolesOf(d.fields)).toEqual({ Word: 'term', Meaning: 'meaning', Level: 'detail' });

    // With the Level pill: Level stays a badge (never the question "A1"), the question stays empty.
    const withLevel = suggestMapping(
      vocab([{ name: 'Dictation', qfmt: `${LEVEL}{{tts de_DE:Word}}{{type:Word}}`, afmt: ANSWER }]),
    ).types[0];
    expect(rolesOf(withLevel.fields)).toEqual({ Word: 'term', Meaning: 'meaning', Level: 'badge' });
    expect(withLevel.templates[0]).toMatchObject({ prompt: [], answer: [0, 1], typeField: 0 });
  });

  it('a type with reading, reverse, listening and dictation directions: every question asks the right field', () => {
    const d = suggestMapping(
      vocab([
        { name: 'DE-EN', qfmt: `{{Word}}${LEVEL}{{tts de_DE:Word}}`, afmt: ANSWER },
        { name: 'EN-DE', qfmt: `{{Meaning}}${LEVEL}`, afmt: '{{FrontSide}}<hr>{{Word}}' },
        { name: 'Listen', qfmt: `${LEVEL}{{tts de_DE:Word}}`, afmt: ANSWER },
        { name: 'Dictation', qfmt: `${LEVEL}{{tts de_DE:Word}}{{type:Word}}`, afmt: ANSWER },
      ]),
    ).types[0];
    expect(rolesOf(d.fields)).toEqual({ Word: 'term', Meaning: 'meaning', Level: 'badge' });
    expect(d.templates.map((t) => [t.name, namesAt(d, t.prompt), namesAt(d, t.answer)])).toEqual([
      ['DE-EN', ['Word'], ['Meaning']],
      ['EN-DE', ['Meaning'], ['Word']],
      ['Listen', ['Word'], ['Meaning']],
      ['Dictation', [], ['Word', 'Meaning']],
    ]);
    // No direction shows its typing field on the question.
    for (const t of d.templates) if (t.typeField !== undefined) expect(t.prompt).not.toContain(t.typeField);
  });

  it('toTemplateDef asks the read-aloud field only while the question shows nothing else', () => {
    const parsed = parseTemplate(`${LEVEL}{{tts de_DE:Word}}`, ANSWER, ['Word', 'Meaning', 'Level']);
    expect(parsed).toMatchObject({ prompt: [2], answer: [0, 1], spoken: [0] });
    const fields = (level: FieldDef['role']): FieldDef[] => [
      { name: 'Word', role: 'term', facet: 'off' },
      { name: 'Meaning', role: 'meaning', facet: 'off' },
      { name: 'Level', role: level, facet: 'auto' },
    ];
    // Level is a pill: the question asks Word, and Word leaves the answer side.
    expect(toTemplateDef(parsed, fields('badge'), { ord: 0, name: 'Listen' })).toMatchObject({ prompt: [0], answer: [1] });
    // Level is hidden: nothing visible is left, so Word is asked (the hidden field stays in the list, never shown).
    expect(toTemplateDef(parsed, fields('hidden'), { ord: 0, name: 'Listen' })).toMatchObject({ prompt: [2, 0], answer: [1] });
    // The learner made Level a normal field: the question shows it, as the template says.
    expect(toTemplateDef(parsed, fields('detail'), { ord: 0, name: 'Listen' })).toMatchObject({ prompt: [2], answer: [0, 1] });
  });
});

/* ---------------------------------------------------------- suggestMapping */

describe('suggestMapping', () => {
  it('prefers the most-filled example field (German Vocabulary version 2: MarankiExample before Examples)', () => {
    const d = draftOf('german_vocabulary_v2');
    expect(namesAt(d, d.examples)).toEqual(['MarankiExample', 'Examples']);
    expect(d.fill[d.examples[0]]).toBeGreaterThan(d.fill[d.examples[1]]);
    expect(namesAt(d, [d.term, d.meaning])).toEqual(['Word', 'Translation']);
  });

  it('gives every direction, on by default, with badges left out of the sides', () => {
    const d = draftOf('german_verbs');
    expect(d.ords).toEqual([0, 1]);
    expect(d.templates.map((t) => t.name)).toEqual(['DE-EN', 'EN-DE']);
    expect(namesAt(d, d.templates[0].prompt)).toEqual(['Verb']);
    expect(namesAt(d, d.templates[0].answer)).toEqual(['Meaning', 'CaseInfo', 'Conjugation', 'Perfekt', 'Prateritum', 'Example']);
    expect(namesAt(d, d.templates[1].prompt)).toEqual(['Meaning', 'CaseInfo']);
    expect(d.kind).toBe('standard');
    expect(d.notes).toBe(20);
    expect(d.distinct[d.fields.findIndex((f) => f.name === 'Level')]).toBe(6);
  });

  it('one-direction decks have one ord; the guess is certain only for a plain Front/Back type', () => {
    expect(draftOf('algo_patterns').ords).toEqual([0]);
    expect(draftOf('algo_patterns').certain).toBe(false); // it also has Category

    const basic: AnkiCollection = {
      fileName: 'basic.apkg',
      crt: 0,
      models: {
        '1': {
          name: 'Basic',
          type: 0,
          sortf: 0,
          flds: [
            { name: 'Front', ord: 0 },
            { name: 'Back', ord: 1 },
          ],
          tmpls: [{ name: 'Card 1', ord: 0, qfmt: '{{Front}}', afmt: '{{FrontSide}}<hr id=answer>{{Back}}' }],
        },
        '2': { name: 'Unused', type: 0, sortf: 0, flds: [], tmpls: [] },
      },
      decks: {},
      notes: [
        { id: 'n1', guid: 'g1', mid: '1', flds: ['Haus', 'house'], tags: [] },
        { id: 'n2', guid: 'g2', mid: '1', flds: ['Baum', 'tree'], tags: [] },
      ],
      cards: [],
      media: {},
    };
    const draft = suggestMapping(basic);
    expect(draft.types).toHaveLength(1); // a model without notes is left out
    expect(draft.types[0].certain).toBe(true);
    expect(draftChoices(draft)).toEqual({
      '1': {
        fields: [
          { name: 'Front', role: 'term', facet: 'off' },
          { name: 'Back', role: 'meaning', facet: 'off' },
        ],
        ords: [0],
      },
    });
  });

  it('a cloze type: ords = every cloze number found − 1', () => {
    const cloze: AnkiCollection = {
      fileName: 'cloze.apkg',
      crt: 0,
      models: {
        '9': {
          name: 'Cloze',
          type: 1,
          sortf: 0,
          flds: [
            { name: 'Text', ord: 0 },
            { name: 'Back Extra', ord: 1 },
          ],
          tmpls: [{ name: 'Cloze', ord: 0, qfmt: '{{cloze:Text}}', afmt: '{{cloze:Text}}<br>{{Back Extra}}' }],
        },
      },
      decks: {},
      notes: [
        { id: 'n1', guid: 'g1', mid: '9', flds: ['{{c1::Paris}} is in {{c3::France}}', ''], tags: [] },
        { id: 'n2', guid: 'g2', mid: '9', flds: ['{{c1::Rome}}', 'Italy'], tags: [] },
      ],
      cards: [],
      media: {},
    };
    const d = suggestMapping(cloze).types[0];
    expect(d.kind).toBe('cloze');
    expect(d.ords).toEqual([0, 2]);

    // The one cloze parser: {{c0::…}} is no card (never ord −1); {{c1,2::…}} is cards 1 and 2.
    const withNotes = (texts: string[]): AnkiCollection => ({
      ...cloze,
      notes: texts.map((t, i) => ({ id: `z${i}`, guid: `gz${i}`, mid: '9', flds: [t, ''], tags: [] })),
    });
    expect(suggestMapping(withNotes(['{{c0::x}} {{c1::y}}'])).types[0].ords).toEqual([0]);
    expect(suggestMapping(withNotes(['{{c0::only zero}}'])).types[0].ords).toEqual([0]);
    expect(suggestMapping(withNotes(['{{c1,2::Paris}}', '{{c4::Rome}}'])).types[0].ords).toEqual([0, 1, 3]);
    // Extra is not where the deletions are hidden, so its markup makes no direction.
    expect(suggestMapping({ ...cloze, notes: [{ id: 'e', guid: 'ge', mid: '9', flds: ['{{c1::a}}', '{{c7::b}}'], tags: [] }] }).types[0].ords).toEqual([0]);
    // "Back Extra" matches the Back pattern, but a cloze card's answer IS the deletion: Extra is a detail row.
    expect(rolesOf(d.fields)).toEqual({ Text: 'term', 'Back Extra': 'detail' });
    expect(d.templates[0].prompt).toEqual([0]);
    expect(d.templates[0].answer).toEqual([1]);
  });

  it('a CSV without a header keeps today\'s positions; a type without templates gets one', () => {
    const csv: AnkiCollection = {
      fileName: 'words.csv',
      crt: 0,
      models: {
        csv: {
          name: 'words.csv',
          type: 0,
          sortf: 0,
          flds: [0, 1, 2, 3].map((i) => ({ name: `Field ${i + 1}`, ord: i })),
          tmpls: [],
        },
      },
      decks: {},
      notes: [
        { id: '1', guid: '', mid: 'csv', flds: ['Haus', 'house', 'Das Haus ist alt.', 'n.'], tags: [] },
        { id: '2', guid: '', mid: 'csv', flds: ['Baum', 'tree', '', 'n.'], tags: [] },
      ],
      cards: [],
      media: {},
      csv: { header: null, delimiter: ',', html: false },
    };
    const d = suggestMapping(csv).types[0];
    expect(d.fields).toEqual([
      { name: 'Field 1', role: 'term', facet: 'off' },
      { name: 'Field 2', role: 'meaning', facet: 'off' },
      { name: 'Field 3', role: 'example', facet: 'off' },
      { name: 'Field 4', role: 'detail', facet: 'auto', label: 'Notes' },
    ]);
    expect(d.templates).toEqual([{ ord: 0, name: 'Card 1', prompt: [0], answer: [1, 2, 3] }]);
    expect(modelTemplates(csv.models.csv, d.fields)).toEqual(d.templates);
  });

  it('an image-only or sound-only field counts as filled; it can be the meaning, never a filter value', () => {
    const media = (flds: { name: string; ord: number }[], qfmt: string, afmt: string, rows: string[][]): AnkiCollection => ({
      fileName: 'media.apkg',
      crt: 0,
      models: { '5': { name: 'Pictures', type: 0, sortf: 0, flds, tmpls: [{ name: 'Card 1', ord: 0, qfmt, afmt }] } },
      decks: {},
      notes: rows.map((flds, i) => ({ id: `m${i}`, guid: `gm${i}`, mid: '5', flds, tags: [] })),
      cards: [],
      media: {},
    });
    const pictureFirst = suggestMapping(
      media(
        [
          { name: 'Picture', ord: 0 },
          { name: 'Word', ord: 1 },
        ],
        '{{Picture}}',
        '{{Word}}',
        [0, 1, 2, 3].map((i) => [`<img src="p${i}.png">`, `word ${i}`]),
      ),
    ).types[0];
    expect(pictureFirst.fill).toEqual([1, 1]);

    // A picture answer (afmt) with an unknown name: rule 7a picks it as the meaning (it has values).
    const pictureAnswer = suggestMapping(
      media(
        [
          { name: 'Word', ord: 0 },
          { name: 'Picture', ord: 1 },
        ],
        '{{Word}}',
        '{{Picture}}',
        [0, 1, 2, 3].map((i) => [`word ${i}`, `<img src="p${i}.png">`]),
      ),
    ).types[0];
    expect(rolesOf(pictureAnswer.fields)).toEqual({ Word: 'term', Picture: 'meaning' });
    expect(pictureAnswer.meaning).toBe(1);

    // A sound counts too; an <img> without a src shows nothing, so it does not; nor does an empty value.
    const sound = suggestMapping(
      media(
        [
          { name: 'Word', ord: 0 },
          { name: 'Audio', ord: 1 },
        ],
        '{{Word}}',
        '{{Audio}}',
        [
          ['a', '[sound:a.mp3]'],
          ['b', '<img alt="none">'],
          ['c', ''],
          ['d', '[sound:d.mp3]'],
        ],
      ),
    ).types[0];
    expect(sound.fill).toEqual([1, 0.5]);
    // A facet counts TEXT values: a picture is never a filter group (distinct stays 0).
    expect(pictureFirst.distinct[0]).toBe(0);
    expect(pictureFirst.fields[0].role).not.toBe('badge');
  });

  it('sorts several card types biggest first', () => {
    const base = fixtureCollection('german_grammar');
    const verbs = fixtureCollection('german_verbs');
    const merged: AnkiCollection = {
      ...base,
      models: { ...base.models, ...verbs.models },
      notes: [...base.notes.slice(0, 5), ...verbs.notes],
    };
    expect(suggestMapping(merged).types.map((t) => [t.name, t.notes])).toEqual([
      ['German Verbs (bidirectional)', 20],
      ['German Grammar', 5],
    ]);
  });
});

/* ------------------------------------- wave 5b: the type of a new card */

describe('newCardTypeId: the card type a new card in a deck starts with (walkthrough L10)', () => {
  const vocab = { id: 'nt-vocab', name: 'German Vocabulary (bidirectional)' };
  const verbs = { id: 'nt-verbs', name: 'German Verbs (bidirectional)' };
  const types: Pick<NoteType, 'id' | 'name'>[] = [vocab, verbs];

  /** `counts` notes per card type id, all in the deck; returns the notes and their id set. */
  function deckNotes(counts: Record<Id, number>): { notes: Pick<Note, 'id' | 'typeId'>[]; ids: Set<Id> } {
    const notes: Pick<Note, 'id' | 'typeId'>[] = [];
    for (const [typeId, n] of Object.entries(counts)) {
      for (let i = 0; i < n; i++) notes.push({ id: `${typeId}-${i}`, typeId });
    }
    return { notes, ids: new Set(notes.map((n) => n.id)) };
  }

  /** An imported deck: every deck gets defaultTypeId 'nt-basic' when it is made (makeDeck). */
  const imported = { defaultTypeId: BUILTIN_TYPE_IDS.basic };

  it('an imported deck with its own card type: its most-used type, not Basic (the German deck)', () => {
    const { notes, ids } = deckNotes({ [vocab.id]: 12, [BUILTIN_TYPE_IDS.basic]: 3 });
    expect(newCardTypeId(imported, notes, ids, types)).toBe(vocab.id);
  });

  it('two own types: the most used wins; a tie goes to the name first A–Z (the picker order)', () => {
    const more = deckNotes({ [vocab.id]: 2, [verbs.id]: 5 });
    expect(newCardTypeId(imported, more.notes, more.ids, types)).toBe(verbs.id);
    // "German Verbs …" comes before "German Vocabulary …" A–Z, whatever the note order.
    const tie = deckNotes({ [vocab.id]: 4, [verbs.id]: 4 });
    expect(newCardTypeId(imported, tie.notes, tie.ids, types)).toBe(verbs.id);
  });

  it('own types present but Basic is used most: Basic (the most used type)', () => {
    const { notes, ids } = deckNotes({ [vocab.id]: 1, [BUILTIN_TYPE_IDS.basic]: 9 });
    expect(newCardTypeId(imported, notes, ids, types)).toBe(BUILTIN_TYPE_IDS.basic);
  });

  it("a deck with only Basic / Basic + reverse / Cloze notes keeps the deck's setting", () => {
    const { notes, ids } = deckNotes({ [BUILTIN_TYPE_IDS.basicReverse]: 9, [BUILTIN_TYPE_IDS.basic]: 1 });
    // The setting is plain Basic: Basic, even though more notes are Basic + reverse.
    expect(newCardTypeId(imported, notes, ids, types)).toBe(BUILTIN_TYPE_IDS.basic);
    // An empty deck: its setting too.
    expect(newCardTypeId({ defaultTypeId: BUILTIN_TYPE_IDS.basicReverse }, [], new Set(), types)).toBe(
      BUILTIN_TYPE_IDS.basicReverse,
    );
    expect(newCardTypeId(imported, [], new Set(), types)).toBe(BUILTIN_TYPE_IDS.basic);
  });

  it('a deliberate choice in the deck editor (not Basic) wins over the most-used type', () => {
    const { notes, ids } = deckNotes({ [vocab.id]: 12 });
    expect(newCardTypeId({ defaultTypeId: BUILTIN_TYPE_IDS.basicReverse }, notes, ids, types)).toBe(
      BUILTIN_TYPE_IDS.basicReverse,
    );
    expect(newCardTypeId({ defaultTypeId: verbs.id }, notes, ids, types)).toBe(verbs.id);
  });

  it('wave 5c: a Basic the learner CHOSE in the deck editor (defaultTypeChosen) wins too; the Basic of makeDeck does not', () => {
    const { notes, ids } = deckNotes({ [vocab.id]: 12, [BUILTIN_TYPE_IDS.basic]: 3 });
    const chosenBasic = { defaultTypeId: BUILTIN_TYPE_IDS.basic, defaultTypeChosen: true };
    expect(newCardTypeId(chosenBasic, notes, ids, types)).toBe(BUILTIN_TYPE_IDS.basic);
    // Without the flag (or with false) it is the Basic every deck gets: the deck's own type wins.
    expect(newCardTypeId(imported, notes, ids, types)).toBe(vocab.id);
    expect(newCardTypeId({ ...chosenBasic, defaultTypeChosen: false }, notes, ids, types)).toBe(vocab.id);
    // The flag never makes an unknown type a choice.
    expect(newCardTypeId({ defaultTypeId: 'nt-gone', defaultTypeChosen: true }, notes, ids, types)).toBe(vocab.id);
  });

  it('only the notes of THIS deck count; unknown card types and unknown settings are ignored', () => {
    const { notes } = deckNotes({ [vocab.id]: 12, 'nt-gone': 50 });
    const elsewhere = new Set<Id>(); // none of these notes is in this deck
    expect(newCardTypeId(imported, notes, elsewhere, types)).toBe(BUILTIN_TYPE_IDS.basic);
    const inDeck = new Set(notes.map((n) => n.id));
    // 'nt-gone' (50 notes) names no card type: the vocabulary type (12) is the deck's own.
    expect(newCardTypeId(imported, notes, inDeck, types)).toBe(vocab.id);
    expect(newCardTypeId({ defaultTypeId: 'nt-gone' }, [], new Set(), types)).toBeNull();
    expect(newCardTypeId({}, [], new Set(), types)).toBeNull();
    expect(newCardTypeId(null, notes, inDeck, types)).toBe(vocab.id);
  });

  it('a built-in legacy type (a migrated German deck) counts as the deck’s own type', () => {
    const legacy = BUILTIN_TYPE_IDS.legacyVocabDe;
    const { notes, ids } = deckNotes({ [legacy]: 30 });
    expect(newCardTypeId(imported, notes, ids, [])).toBe(legacy);
  });
});

/* ------------------------- review of L10: the deck editor's "Card type" */

describe('deckCardTypeChoices: the deck editor shows what new cards really start with (review of L10)', () => {
  const vocab = { id: 'nt-vocab', name: 'German Vocabulary (bidirectional)' };
  const verbs = { id: 'nt-verbs', name: 'German Verbs (bidirectional)' };
  const types: Pick<NoteType, 'id' | 'name'>[] = [vocab, verbs];
  const BASIC = BUILTIN_TYPE_IDS.basic;
  const REVERSE = BUILTIN_TYPE_IDS.basicReverse;

  /** `counts` notes per card type id, all in the deck. */
  function deckNotes(counts: Record<Id, number>): { notes: Pick<Note, 'id' | 'typeId'>[]; ids: Set<Id> } {
    const notes: Pick<Note, 'id' | 'typeId'>[] = [];
    for (const [typeId, n] of Object.entries(counts)) {
      for (let i = 0; i < n; i++) notes.push({ id: `${typeId}-${i}`, typeId });
    }
    return { notes, ids: new Set(notes.map((n) => n.id)) };
  }

  /** Every deck gets defaultTypeId 'nt-basic' when it is made (makeDeck), also an imported one. */
  const imported = { defaultTypeId: BASIC };

  /** How the deck editor saves a choice (deck-editor.tsx): the type, marked as chosen by the learner. */
  const saved = (id: Id) => ({ defaultTypeId: id, defaultTypeChosen: true });

  it('an imported German deck: it shows "German Vocabulary", and Basic stays a choice that works (wave 5c)', () => {
    const { notes, ids } = deckNotes({ [vocab.id]: 6845, [BASIC]: 3 });
    const choices = deckCardTypeChoices(imported, notes, ids, types);
    // The value is the type the card editor starts a new card with.
    expect(choices.value).toBe(newCardTypeId(imported, notes, ids, types));
    expect(choices.value).toBe(vocab.id);
    expect(choices.options).toEqual([
      { id: vocab.id, name: 'German Vocabulary (bidirectional)', uses: 6845 },
      { id: BASIC, name: 'Basic', uses: 3 },
      { id: REVERSE, name: 'Basic + reverse', uses: 0 },
    ]);
    // Basic saved by the deck editor: new cards start as Basic, and the editor shows Basic next time.
    expect(newCardTypeId(saved(BASIC), notes, ids, types)).toBe(BASIC);
    const basic = deckCardTypeChoices(saved(BASIC), notes, ids, types);
    expect(basic.value).toBe(BASIC);
    // The deck's own type stays a choice, so the learner can go back to it.
    expect(basic.options.map((o) => o.id)).toEqual([vocab.id, BASIC, REVERSE]);
    expect(newCardTypeId(saved(vocab.id), notes, ids, types)).toBe(vocab.id);
  });

  it('the learner picks Basic + reverse, then goes back: each saved choice is what the editor shows next time', () => {
    const { notes, ids } = deckNotes({ [vocab.id]: 12 });
    const reverse = deckCardTypeChoices({ defaultTypeId: REVERSE }, notes, ids, types);
    expect(reverse.value).toBe(REVERSE);
    expect(newCardTypeId({ defaultTypeId: REVERSE }, notes, ids, types)).toBe(REVERSE);
    // The deck's own type stays a choice, so the learner can go back to it.
    expect(reverse.options.map((o) => o.id)).toEqual([vocab.id, BASIC, REVERSE]);
    const back = deckCardTypeChoices({ defaultTypeId: vocab.id }, notes, ids, types);
    expect(back.value).toBe(vocab.id);
    expect(newCardTypeId({ defaultTypeId: vocab.id }, notes, ids, types)).toBe(vocab.id);
  });

  it('a deck made in the app: Basic and Basic + reverse, as before (also a new, empty deck)', () => {
    const { notes, ids } = deckNotes({ [BASIC]: 5, [REVERSE]: 2 });
    expect(deckCardTypeChoices(imported, notes, ids, types)).toEqual({
      value: BASIC,
      options: [
        { id: BASIC, name: 'Basic', uses: 5 },
        { id: REVERSE, name: 'Basic + reverse', uses: 2 },
      ],
    });
    // The setting Basic + reverse: selected, and the order stays "Basic", "Basic + reverse".
    const reverse = deckCardTypeChoices({ defaultTypeId: REVERSE }, notes, ids, types);
    expect(reverse.value).toBe(REVERSE);
    expect(reverse.options.map((o) => o.id)).toEqual([BASIC, REVERSE]);
    const fresh = deckCardTypeChoices(null, [], new Set(), []);
    expect(fresh.value).toBe(BASIC);
    expect(fresh.options.map((o) => o.name)).toEqual(['Basic', 'Basic + reverse']);
  });

  it('Basic is used most next to an own type: Basic is shown, and every type of the deck is offered', () => {
    const { notes, ids } = deckNotes({ [vocab.id]: 1, [BASIC]: 9 });
    const choices = deckCardTypeChoices(imported, notes, ids, types);
    expect(choices.value).toBe(BASIC);
    // Basic is the value here (it is the most used type): offered, like every type of the deck.
    expect(choices.options.map((o) => o.id)).toEqual([vocab.id, BASIC, REVERSE]);
  });

  it('two own types: both are offered, the most used first; a Cloze setting is shown as itself', () => {
    const { notes, ids } = deckNotes({ [vocab.id]: 2, [verbs.id]: 5 });
    expect(deckCardTypeChoices(imported, notes, ids, types).options.map((o) => o.id)).toEqual([verbs.id, vocab.id, BASIC, REVERSE]);
    const cloze = deckCardTypeChoices({ defaultTypeId: BUILTIN_TYPE_IDS.cloze }, [], new Set(), types);
    expect(cloze.value).toBe(BUILTIN_TYPE_IDS.cloze);
    expect(cloze.options.map((o) => o.name)).toEqual(['Cloze', 'Basic', 'Basic + reverse']);
  });

  it('a type id that names no card type is never a choice', () => {
    const { notes, ids } = deckNotes({ 'nt-gone': 40, [vocab.id]: 2 });
    const choices = deckCardTypeChoices({ defaultTypeId: 'nt-gone' }, notes, ids, types);
    expect(choices.value).toBe(vocab.id);
    expect(choices.options.map((o) => o.id)).toEqual([vocab.id, BASIC, REVERSE]);
  });

  it('300 random decks: the value IS newCardTypeId, it is offered, and every choice takes effect when saved', () => {
    const rnd = createRandom('deck-card-type-choices');
    const pool: Id[] = [BASIC, REVERSE, BUILTIN_TYPE_IDS.cloze, vocab.id, verbs.id, BUILTIN_TYPE_IDS.legacyVocabDe, 'nt-gone'];
    for (let run = 0; run < 300; run++) {
      const counts: Record<Id, number> = {};
      for (const id of rnd.sample(pool, rnd.int(0, 4))) counts[id] = rnd.int(1, 6);
      const { notes, ids } = deckNotes(counts);
      const deck = rnd.bool(0.2)
        ? null
        : { defaultTypeId: rnd.bool(0.15) ? undefined : rnd.pick(pool), ...(rnd.bool(0.3) ? { defaultTypeChosen: true } : {}) };
      const choices = deckCardTypeChoices(deck, notes, ids, types);
      const context = `seed ${rnd.seed}, run ${run}`;
      expect([context, choices.value]).toEqual([context, newCardTypeId(deck, notes, ids, types) ?? BASIC]);
      expect([context, choices.options.some((o) => o.id === choices.value)]).toEqual([context, true]);
      // Saved the way the deck editor saves it (marked as chosen), every choice is what new cards start with.
      for (const option of choices.options) {
        expect([context, newCardTypeId(saved(option.id), notes, ids, types) ?? BASIC]).toEqual([context, option.id]);
      }
      // No choice twice; Basic and Basic + reverse are always offered (they always take effect, wave 5c).
      expect([context, new Set(choices.options.map((o) => o.id)).size]).toEqual([context, choices.options.length]);
      expect([context, choices.options.some((o) => o.id === REVERSE)]).toEqual([context, true]);
      expect([context, choices.options.some((o) => o.id === BASIC)]).toEqual([context, true]);
    }
  });
});
