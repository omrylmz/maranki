/**
 * Templates → directions and field roles (spec §5.3). An Anki card type
 * ("note type") has fields and templates. Each template is one direction: a
 * question template (`qfmt`) and an answer template (`afmt`), written in
 * Anki's {{Field}} syntax. This file READS those templates — it does not run
 * Anki's template engine — and guesses how each field should look.
 *
 *   parseTemplate(qfmt, afmt, fieldNames)      which fields are on which side, {{tts}} languages, {{type:}}
 *   inferFieldRoles(type, notes, presets)      the role of every field (term, meaning, example, badge …)
 *   toTemplateDef(parsed, fields, meta)        one direction as the model stores it (badges left out)
 *   suggestMapping(collection, presets)        the import screen's starting guess, per source card type
 *   newCardTypeId(deck, notes, noteIds, types) the card type a NEW card in a deck starts with
 *   deckCardTypeChoices(deck, notes, noteIds, types) the deck editor's "Card type": that value + the choices that work
 *
 * Real check (German Verbs, "EN-DE"): the qfmt shows {{Meaning}} and
 * "Hint: {{CaseInfo}}" (plus Level and Tags, which are badges), so the
 * prompt is [Meaning, CaseInfo]. Up to verbs version 3 the deck wrote
 * {{{CaseInfo}}}; three braces read like two (TEMPLATE_TAG).
 *
 * Pure: no React, no I/O. Hermes-safe (no lookbehind, no `normalize`).
 */
import { stripHtml } from './anki';
import { BUILTIN_TYPE_IDS, builtinKindOf, builtinType } from './builtinTypes';
import { clozeNumbers } from './cloze';
import { htmlToLines } from './htmlLines';
import { normalizeLang } from './lang/bcp47';
import type { AnkiCollection, Deck, FieldDef, FieldRole, Id, ImportChoices, Note, NoteType, TemplateDef } from './model';
import { clozeFields } from './render';
import { foldText } from './text';

/* -------------------------------------------------------------- templates */

/** What one template (qfmt + afmt) shows, by field index. Badges are NOT removed yet. */
export interface ParsedTemplate {
  /** Fields shown on the question side, in first-appearance order. */
  prompt: number[];
  /** Fields shown on the answer side that are not on the question side, in afmt order. */
  answer: number[];
  /**
   * Fields the QUESTION side reads aloud ({{tts}}), in first-appearance order,
   * the typing field included. A question that shows nothing else (or only
   * badges) asks these instead, but never the typing field: see spokenAsked.
   */
  spoken: number[];
  /** Field index → BCP-47 language from {{tts de_DE:Field}} (either side). */
  langs: Record<number, string>;
  /** From {{type:Field}}: the field the learner types. */
  typeField?: number;
  /** True when a side uses {{cloze:Field}}. */
  cloze: boolean;
}

/** {{Field}} or {{{Field}}}: group 1 is the text between the braces. */
const TEMPLATE_TAG = /\{\{\{?([^{}]*?)\}?\}\}/g;

/** Field name → index: an exact match first, then one that ignores case. */
function fieldIndexer(fieldNames: readonly string[]): (name: string) => number {
  const exact = new Map<string, number>();
  const loose = new Map<string, number>();
  fieldNames.forEach((name, i) => {
    if (!exact.has(name)) exact.set(name, i);
    const key = name.trim().toLowerCase();
    if (!loose.has(key)) loose.set(key, i);
  });
  return (name) => exact.get(name) ?? loose.get(name.trim().toLowerCase()) ?? -1;
}

/** One side of a template: the fields shown, the fields read aloud, the {{tts}} languages, {{type:}} and {{cloze:}}. */
function scanSide(
  template: string,
  indexOf: (name: string) => number,
  side: 'prompt' | 'answer',
): { shown: number[]; spoken: number[]; langs: Record<number, string>; typeField?: number; cloze: boolean } {
  const shown: number[] = [];
  const spoken: number[] = [];
  const langs: Record<number, string> = {};
  let typeField: number | undefined;
  let cloze = false;
  TEMPLATE_TAG.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TEMPLATE_TAG.exec(template)) !== null) {
    const inner = m[1].trim();
    // {{#Field}} / {{^Field}} / {{/Field}}: conditionals. The fields INSIDE are collected on their own.
    if (inner === '' || inner[0] === '#' || inner[0] === '^' || inner[0] === '/' || inner[0] === '!') continue;
    if (inner === 'FrontSide') continue; // the answer side always echoes the prompt
    const parts = inner.split(':');
    const field = indexOf(parts[parts.length - 1].trim());
    if (field === -1) continue; // static text, {{Tags}}, {{Deck}} … (not a field of this type)
    const filters = parts.slice(0, -1).map((f) => f.trim().toLowerCase());

    const tts = filters.find((f) => f === 'tts' || f.startsWith('tts '));
    if (tts !== undefined) {
      // {{tts de_DE voices=… speed=…:Word}} → the language is the word after "tts".
      const lang = normalizeLang(tts.split(/\s+/)[1] ?? '');
      if (lang && langs[field] === undefined) langs[field] = lang;
      if (!spoken.includes(field)) spoken.push(field);
      continue; // read aloud, not shown (see parseTemplate for a side that ONLY reads aloud)
    }
    if (filters.includes('type')) {
      if (typeField === undefined) typeField = field;
      if (side === 'prompt') continue; // the typing box; the answer side shows the comparison
    }
    if (filters.includes('cloze')) cloze = true;
    if (!shown.includes(field)) shown.push(field);
  }
  return { shown, spoken, langs, typeField, cloze };
}

/**
 * Which fields one template shows on each side (spec §5.3 table):
 *   {{Field}}, {{{Field}}}, {{text:Field}} → shown on this side;
 *   {{#Field}}…{{/Field}}, {{^Field}}…{{/Field}} → the fields inside are collected;
 *   {{FrontSide}} → ignored; static text → dropped;
 *   {{tts de_DE:Word}} → langs[Word] = 'de-DE' (not "shown"; on the question side: `spoken`);
 *   {{type:Field}} → typeField; {{cloze:Text}} → cloze.
 * `answer` = fields of afmt that are not in `prompt`, in afmt order.
 *
 * A side that only READS fields aloud: Anki's listening card has qfmt
 * '{{tts de_DE:Word}}' and afmt '{{Word}}<br>{{Meaning}}'. In Anki the card
 * plays the word. Maranki has no Anki audio, so a question without fields
 * would be blank, and the speaker button would have no headline to speak.
 * So when a side shows no field at all, its {{tts}} fields are shown
 * instead: prompt [Word], answer [Meaning]. The read-aloud button can then
 * speak the word (it has `lang` from the same tag).
 *
 * The question NEVER shows its typing field this way. Anki's dictation card
 * has qfmt '{{tts de_DE:Word}}{{type:Word}}': "listen, then type the word".
 * Showing Word above the typing box would show the answer, so that question
 * stays empty (prompt [], answer [Word, Meaning], typeField Word).
 */
export function parseTemplate(
  qfmt: string,
  afmt: string,
  fieldNames: readonly string[],
): ParsedTemplate {
  const indexOf = fieldIndexer(fieldNames);
  const q = scanSide(qfmt ?? '', indexOf, 'prompt');
  const a = scanSide(afmt ?? '', indexOf, 'answer');
  const typeField = q.typeField ?? a.typeField;
  // A side that only reads aloud shows what it reads (see above), so it is never blank.
  // The question side leaves out the typing field (the dictation card above).
  const prompt = q.shown.length > 0 ? q.shown : spokenAsked({ spoken: q.spoken, typeField });
  // On the answer side the typed field IS the answer, so it may be shown there.
  const answerShown = a.shown.length > 0 ? a.shown : a.spoken;
  const parsed: ParsedTemplate = {
    prompt,
    answer: answerShown.filter((i) => !prompt.includes(i)),
    spoken: q.spoken,
    langs: { ...a.langs, ...q.langs },
    cloze: q.cloze || a.cloze,
  };
  if (typeField !== undefined) parsed.typeField = typeField;
  return parsed;
}

/**
 * The read-aloud question fields that a question may ASK (show): every
 * {{tts}} field of the question side except the typing field. The learner
 * must never see the answer they are asked to type.
 *
 *   spokenAsked({ spoken: [0], typeField: 0 })   // dictation: tts Word + type Word
 *   → []
 *   spokenAsked({ spoken: [0] })                 // listening: tts Word only
 *   → [0]
 */
function spokenAsked(t: Pick<ParsedTemplate, 'spoken' | 'typeField'>): number[] {
  return t.spoken.filter((i) => i !== t.typeField);
}

/**
 * One direction as the model stores it (spec §5.3): `prompt` = the qfmt
 * fields that are not badges; `answer` = the afmt fields that are not in the
 * prompt and not badges, in afmt order. The raw qfmt/afmt are kept, so the
 * template can be built again when a role changes.
 *
 * A listening question that shows only badges: the German decks put the
 * level above the word, so a listening template looks like
 * '<div class="level">{{Level}}</div>{{tts de_DE:Word}}'. Without its badges
 * this question shows no field, so it asks the field it reads aloud instead
 * (spokenAsked: never the typing field): prompt [Word], answer [Meaning], and
 * Level stays a pill. The same rule as a side that only reads aloud (see
 * parseTemplate); inferFieldRoles keeps Level a badge for this reason.
 */
export function toTemplateDef(
  parsed: ParsedTemplate,
  fields: readonly FieldDef[],
  meta: { ord: number; name: string; qfmt?: string; afmt?: string },
): TemplateDef {
  const notBadge = (i: number) => fields[i] !== undefined && fields[i].role !== 'badge';
  // "Visible" = renderFace shows it on a side: not a badge and not hidden.
  const visible = (i: number) => notBadge(i) && fields[i].role !== 'hidden';
  const kept = parsed.prompt.filter(notBadge);
  // Nothing visible left on the question → ask the read-aloud fields (see above).
  const prompt = kept.some(visible)
    ? kept
    : [...kept, ...spokenAsked(parsed).filter((i) => visible(i) && !kept.includes(i))];
  const def: TemplateDef = {
    ord: meta.ord,
    name: meta.name,
    prompt,
    answer: parsed.answer.filter((i) => notBadge(i) && !prompt.includes(i)),
  };
  if (parsed.typeField !== undefined) def.typeField = parsed.typeField;
  if (meta.qfmt !== undefined) def.qfmt = meta.qfmt;
  if (meta.afmt !== undefined) def.afmt = meta.afmt;
  return def;
}

/** One source model of an AnkiCollection (an .apkg card type, or a CSV's synthesized one). */
export type AnkiModel = AnkiCollection['models'][string];

/** The model's field names, in field order (Anki `ord`). */
export function modelFieldNames(model: AnkiModel): string[] {
  return [...model.flds].sort((a, b) => a.ord - b.ord).map((f) => f.name);
}

/** Every template of a model, parsed, in `ord` order. */
export function parseModelTemplates(model: AnkiModel): ParsedTemplate[] {
  const names = modelFieldNames(model);
  return [...model.tmpls]
    .sort((a, b) => a.ord - b.ord)
    .map((t) => parseTemplate(t.qfmt, t.afmt, names));
}

/**
 * The directions of a model with the CHOSEN field roles (the import planner
 * calls this after the learner changed roles on the Fields stage). A model
 * with no template (a CSV) gets one: the term (or the first field) asks,
 * every other shown field answers.
 */
export function modelTemplates(model: AnkiModel, fields: readonly FieldDef[]): TemplateDef[] {
  const tmpls = [...model.tmpls].sort((a, b) => a.ord - b.ord);
  if (tmpls.length === 0) return [fallbackTemplate(fields)];
  const names = modelFieldNames(model);
  return tmpls.map((t) =>
    toTemplateDef(parseTemplate(t.qfmt, t.afmt, names), fields, {
      ord: t.ord,
      name: t.name,
      qfmt: t.qfmt,
      afmt: t.afmt,
    }),
  );
}

/** "Front → Back" for a type without templates: term (or field 0) asks; the other shown fields answer. */
function fallbackTemplate(fields: readonly FieldDef[]): TemplateDef {
  const term = fields.findIndex((f) => f.role === 'term');
  const ask = term === -1 ? 0 : term;
  const answer = fields
    .map((f, i) => ({ f, i }))
    .filter(({ f, i }) => i !== ask && f.role !== 'badge' && f.role !== 'hidden')
    .map(({ i }) => i);
  return { ord: 0, name: 'Card 1', prompt: fields.length > 0 ? [ask] : [], answer };
}

/* ---------------------------------------------------------------- presets */

/**
 * A content pack's preset for one card type (spec §9.4), matched by the
 * card type's name. Applied by inferFieldRoles rule 1: presets win.
 *
 * NOTE: spec §9.4 puts this interface in src/variants/types.ts (wave 5). It
 * is defined here until that file exists; the shape is the same.
 */
export interface CardTypePreset {
  /** Matched against the card type's name, e.g. /^German Verbs/. */
  match: RegExp;
  /** By field name: the values to use (role, label, lang, facet, multiSep). */
  fields: Record<string, Partial<FieldDef>>;
}

/** The first preset whose `match` fits the type name (lastIndex-safe for /g regexes). */
function presetFor(name: string, presets: readonly CardTypePreset[]): CardTypePreset | undefined {
  return presets.find((p) => name.search(p.match) !== -1);
}

/* --------------------------------------------------------- the data rule */

/** Spec §4.3: a filter group has at most 24 values, … */
export const FACET_MAX_VALUES = 24;
/** … is filled in at least half of the notes, … */
export const FACET_MIN_FILL = 0.5;
/** … and has no value longer than 40 characters. */
export const FACET_MAX_LENGTH = 40;
/** Multi-value fields: more than 1.2 values per note on average. */
export const FACET_MIN_TOKENS = 1.2;

export interface FacetRuleResult {
  pass: boolean;
  /** Set when the field holds several values per note ("regular, separable"). */
  multiSep?: ',' | ';' | '|';
}

/** A field value as the facet rule sees it: HTML stripped, trimmed, folded. */
function foldValue(raw: string): string {
  return foldText(stripHtml(raw ?? '')).trim();
}

/** Few, short, REPEATING values. */
function smallValueSet(items: readonly string[]): boolean {
  const distinct = new Set(items);
  if (distinct.size > FACET_MAX_VALUES) return false;
  // Values must repeat (on average 2 notes per value). Without this, any
  // field of a small deck (20 words → 20 values ≤ 24) would look like a filter.
  if (distinct.size * 2 > items.length) return false;
  for (const v of distinct) if (v.length > FACET_MAX_LENGTH) return false;
  return true;
}

/**
 * The data rule of spec §4.3, on the values of ONE field (one string per
 * note of the card type; '' = empty). It passes when the folded values
 * (HTML stripped, trimmed, lower case, no accents) are
 *   - filled in ≥ 50% of the notes,
 *   - ≤ 24 distinct values, none longer than 40 characters,
 *   - and repeating: distinct values ≤ half of the filled notes (see below);
 * or, as a MULTI-value field, when splitting on ',' ';' or '|' gives ≤ 24
 * distinct short repeating tokens and more than 1.2 tokens per note
 * (German Verbs "Tags": 84 raw values → 20 tokens).
 *
 * The "repeating" condition is NOT in §4.3. It is added for role guessing:
 * on a small deck every field has ≤ 24 values, so without it the words
 * themselves would become badges. On the real decks it changes nothing
 * (Level has 5 values over 6,845 notes).
 */
export function facetRule(values: readonly string[]): FacetRuleResult {
  if (values.length === 0) return { pass: false };
  const filled = values.map(foldValue).filter((v) => v !== '');
  if (filled.length === 0 || filled.length < values.length * FACET_MIN_FILL) return { pass: false };
  if (smallValueSet(filled)) return { pass: true };
  for (const sep of [',', ';', '|'] as const) {
    const tokens: string[] = [];
    for (const v of filled) {
      for (const t of v.split(sep)) {
        const token = t.trim();
        if (token !== '') tokens.push(token);
      }
    }
    if (tokens.length > filled.length * FACET_MIN_TOKENS && smallValueSet(tokens)) {
      return { pass: true, multiSep: sep };
    }
  }
  return { pass: false };
}

/* ------------------------------------------------------------------ roles */

/*
 * Name patterns. FRONT_RE, BACK_RE and EX_RE are the same patterns as in
 * anki.ts (the old importer; not exported there, and anki.ts stays as it is).
 * They are tested on the field name with camelCase and '_' split into words
 * ("MarankiExample" → "Maranki Example"), so a word inside a compound name
 * still matches.
 */
const FRONT_RE = /(?:^|[^a-z0-9])(word|wort|front|vorderseite|begriff|term|termino|término|terme|expression|expresion|expresión|frage|question|prompt|headword|lemma|vocab|palabra|mot|parola|vocabolo)/i;
const BACK_RE = /(?:^|[^a-z0-9])(translation|traduccion|traducción|traduction|traduzione|ubersetzung|übersetzung|meaning|significado|significato|signification|bedeutung|back(?![a-z])|ruckseite|rückseite|definition|definicion|definición|answer|antwort|respuesta|reponse|réponse|risposta|output|english|gloss|sense|sentido|senso)/i;
const EX_RE = /(?:^|[^a-z0-9])(example|ejemplo|exemple|esempio|beispiel|satz|sentence|frase|phrase|oracion|oración|usage|context|contexto|sample)/i;
/** Rule 6: an example's translation ("Example translation", "ExampleEN"). */
const EX_MEANING_RE = /translation.*example|example.*(translation|english|en)$/i;
/** Rule 3: a pronunciation field by name ("ipa" only as a whole word: not "Principal"). */
const PRON_RE = /(?:^|[^a-z0-9])(pronunc|ipa(?![a-z])|aussprache|phonetic|pinyin|reading)/i;
/** Rule 3: a value that looks like IPA: /…/, […], or IPA letters. */
const IPA_VALUE = /^\/.+\/$|^\[.+\]$|[ˈːəʃ]/;

/** "MarankiExample" → "Maranki Example"; "example_translation" → "example translation". */
function nameWords(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .trim();
}

/** The default `facet` of a role: free-text roles are never filter groups. */
function facetFor(role: FieldRole): FieldDef['facet'] {
  return role === 'badge' || role === 'detail' || role === 'hidden' ? 'auto' : 'off';
}

/** What inferFieldRoles needs to know about a card type. */
export interface RoleTypeInput {
  /** The card type name (presets match on it). */
  name: string;
  /** Field names, in field order. */
  fieldNames: readonly string[];
  /** The parsed templates in `ord` order; [0] is the first direction. */
  templates: readonly ParsedTemplate[];
}

/** An image or a sound in raw field text (the only things a field can show without text). */
const MEDIA_MARK = /<img|\[sound:/i;

/**
 * True when a field value shows something on a card: text, or an image or a
 * sound that the renderer keeps (htmlToLines). So a "Picture" field with only
 * '<img src="p0.png">' counts as filled. The facet rule still reads TEXT only
 * (foldValue): a picture is never a filter value.
 */
function isFilled(raw: string): boolean {
  const value = raw ?? '';
  if (foldValue(value) !== '') return true;
  return MEDIA_MARK.test(value) && htmlToLines(value).length > 0;
}

/** Share of notes whose field `i` is filled (0..1); images and sounds count (see isFilled). */
function fillShare(notes: readonly (readonly string[])[], i: number): number {
  if (notes.length === 0) return 0;
  let filled = 0;
  for (const row of notes) if (isFilled(row[i] ?? '')) filled++;
  return filled / notes.length;
}

/**
 * The role of every field of a card type (spec §5.3), from its name, its
 * templates and its notes' values. `notes` holds one row of field values per
 * note, aligned with `type.fieldNames`. First matching rule wins:
 *
 *   1. a pack preset for this card-type name (presets win);
 *   2. badge by data: passes the facet rule → 'badge', facet 'auto' (+ multiSep),
 *      but only for a field that is SAFE as a pill (see `pillSafe` below);
 *   3. pronunciation: the name says so, or ≥ 60% of the values look like IPA;
 *   4. template position: the first prompt field of ord 0 → 'term'; the first
 *      prompt field of the reverse template → 'meaning' (never for a cloze
 *      type: its answer is the deletion, so "Back Extra" stays a detail).
 *      "Prompt field" = a field the template really asks: a question field
 *      that is not a badge or hidden; none → a field it reads aloud ({{tts}},
 *      never the typing field), as toTemplateDef builds the prompt;
 *   6. (checked before 5) an example's translation by name → 'exampleMeaning';
 *   5. name patterns → 'term' / 'meaning' (one each, the most-filled match),
 *      'example' (every match: the renderer shows every non-empty one);
 *   7a. still no term / meaning → the first free field / the next free field
 *      with values (template order, then field order), as the old importer did;
 *      an image or a sound is a value here (a "Picture" answer can be the meaning);
 *   7. everything else → 'detail' (a labelled row, template order).
 *
 * Rule 6 runs before rule 5 because a name like "Example translation"
 * matches both "translation" (meaning) and "example". Rule 7a is not in the
 * spec's list: without it, a card type with unknown field names would have
 * no Front and no Back on the import screen.
 *
 * Why rule 2 has a "safe as a pill" check (not in the spec's list): a badge
 * is drawn on the top row BEFORE the answer is revealed, and it is taken off
 * both sides. Anki's own "Basic" type with Back = der/die/das (or A–D, or
 * True/False) passes the facet rule, so without the check the answer would
 * show as a pill on the question side and the revealed side would be empty.
 *
 *   pillSafe(field):
 *     - a type WITH templates: the field is on a question side somewhere and
 *       it is never an answer-only field of any template. (A field that is
 *       only a condition, like "Add Reverse", is on no side: never a badge.)
 *     - a type WITHOUT templates (a CSV): the name does not say Front or Back
 *       ("Answer", "Back", "Word" …).
 *   After rule 2, badges may never take every question field of a template
 *   (a blank question), and a type without templates keeps two normal fields
 *   with values (a Front and a Back). When they would, the badge with the
 *   most different values goes back to being a normal field.
 *   Not for a LISTENING question ('<div>{{Level}}</div>{{tts de_DE:Word}}'):
 *   it asks Word, the field it reads aloud (toTemplateDef), so Level stays a
 *   badge. Without this, Level would become the term and the card would ask
 *   "A1". A dictation card ({{tts:Word}}{{type:Word}}) keeps its badges too:
 *   it can never show Word (the answer it types), and "A1" is no question.
 *
 * On the five real decks the check changes nothing: Level, Type, Category
 * and Tags are always on the question side and never answer-only.
 *
 * Every field also gets `lang` from {{tts}} and `facet` ('auto' for badge,
 * detail and hidden; 'off' for the free-text roles). Preset values (role,
 * label, lang, facet, multiSep) are applied last and win.
 */
export function inferFieldRoles(
  type: RoleTypeInput,
  notes: readonly (readonly string[])[],
  presets: readonly CardTypePreset[] = [],
): FieldDef[] {
  const names = type.fieldNames;
  const count = names.length;
  const values = (i: number) => notes.map((row) => row[i] ?? '');
  const preset = presetFor(type.name, presets);
  const presetOf = (i: number) => preset?.fields[names[i]];

  // Fill shares are read by several rules: compute each one once.
  const fills: (number | undefined)[] = [];
  const fillOf = (i: number): number => {
    let share = fills[i];
    if (share === undefined) {
      share = fillShare(notes, i);
      fills[i] = share;
    }
    return share;
  };

  const roles: (FieldRole | null)[] = names.map(() => null);
  const multiSep: (FacetRuleResult['multiSep'] | undefined)[] = [];
  const undecided = (i: number) => i >= 0 && i < count && roles[i] === null;
  const taken = (role: FieldRole) => roles.includes(role);

  // 1. Pack preset.
  for (let i = 0; i < count; i++) {
    const role = presetOf(i)?.role;
    if (role) roles[i] = role;
  }
  // 2. Badge by data, only for a field that is safe as a pill (see the comment above).
  const hasTemplates = type.templates.length > 0;
  const pillSafe = (i: number): boolean => {
    if (!hasTemplates) {
      const words = nameWords(names[i]);
      return !FRONT_RE.test(words) && !BACK_RE.test(words);
    }
    // ParsedTemplate.answer already leaves out the fields of that template's question side.
    return type.templates.some((t) => t.prompt.includes(i)) && !type.templates.some((t) => t.answer.includes(i));
  };
  const byData: boolean[] = names.map(() => false);
  for (let i = 0; i < count; i++) {
    if (!undecided(i) || !pillSafe(i)) continue;
    const rule = facetRule(values(i));
    if (rule.pass) {
      roles[i] = 'badge';
      multiSep[i] = rule.multiSep;
      byData[i] = true;
    }
  }
  // 2b. Badges never empty a side. `among` = the fields to look at; the data badge
  // with the most different values (the least "badge-like") becomes undecided again.
  const unBadgeOne = (among: readonly number[]): boolean => {
    let best = -1;
    let bestDistinct = -1;
    for (const i of among) {
      if (!byData[i]) continue;
      const distinct = new Set(values(i).map(foldValue).filter((v) => v !== '')).size;
      if (distinct > bestDistinct) {
        best = i;
        bestDistinct = distinct;
      }
    }
    if (best === -1) return false;
    roles[best] = null;
    multiSep[best] = undefined;
    byData[best] = false;
    return true;
  };
  const offSides = (i: number) => roles[i] === 'badge' || roles[i] === 'hidden';
  if (hasTemplates) {
    // A template whose question fields are ALL badges would ask a blank question …
    for (const t of type.templates) {
      if (t.prompt.length === 0 || !t.prompt.every(offSides)) continue;
      // … unless it is a listening question: it asks the field it reads aloud
      // (toTemplateDef), so its badges stay pills. A dictation card reads aloud
      // and types the SAME field: it has nothing to show without audio, and
      // its Level as the question would be wrong, so its badges stay pills too.
      if (t.spoken.some((i) => !offSides(i))) continue;
      unBadgeOne(t.prompt);
    }
  } else {
    // No template: the fallback asks one field and answers with the others,
    // so keep two normal fields with values (a Front and a Back).
    const all = names.map((_, i) => i);
    const normalWithValues = () => all.filter((i) => !offSides(i) && fillOf(i) > 0).length;
    // Each pass turns one data badge back into a normal field; it stops when no data badge is left.
    let enough = normalWithValues() >= 2;
    while (!enough && unBadgeOne(all)) enough = normalWithValues() >= 2;
  }
  // 3. Pronunciation.
  for (let i = 0; i < count; i++) {
    if (!undecided(i)) continue;
    if (PRON_RE.test(nameWords(names[i]))) {
      roles[i] = 'pronunciation';
      continue;
    }
    const filled = values(i)
      .map((v) => stripHtml(v))
      .filter((v) => v !== '');
    const ipa = filled.filter((v) => IPA_VALUE.test(v)).length;
    if (filled.length > 0 && ipa >= filled.length * 0.6) roles[i] = 'pronunciation';
  }
  // 4. Template position. "Eligible" = not decided by rules 1–3.
  const decided123 = roles.slice();
  const eligible = (i: number) => i >= 0 && i < count && decided123[i] === null;
  // The fields a template really ASKS, as toTemplateDef builds them: its question fields
  // that are not badges or hidden; none → the fields it reads aloud (never the typing field).
  const asked = (t: ParsedTemplate): number[] => {
    const shown = t.prompt.filter((i) => !offSides(i));
    return shown.length > 0 ? shown : spokenAsked(t).filter((i) => !offSides(i));
  };
  const [first, ...others] = type.templates;
  if (first && !taken('term')) {
    const i = asked(first).find(eligible);
    if (i !== undefined) roles[i] = 'term';
  }
  // A cloze card's answer is the deletion itself, so a cloze type gets no 'meaning' field
  // ("Back Extra" stays a detail row, spec §6.2).
  const isCloze = type.templates.some((t) => t.cloze);
  if (!taken('meaning') && !isCloze) {
    for (const t of others) {
      const i = asked(t).find(eligible);
      if (i !== undefined && undecided(i)) {
        roles[i] = 'meaning';
        break;
      }
    }
  }
  // 6. Example translation.
  for (let i = 0; i < count; i++) {
    if (undecided(i) && EX_MEANING_RE.test(nameWords(names[i]))) roles[i] = 'exampleMeaning';
  }
  // 5. Name patterns: one term and one meaning (the most-filled match), every example.
  const pickMostFilled = (re: RegExp): number => {
    let best = -1;
    let bestFill = -1;
    for (let i = 0; i < count; i++) {
      if (!undecided(i) || !re.test(nameWords(names[i]))) continue;
      const fill = fillOf(i);
      if (fill > bestFill) {
        best = i;
        bestFill = fill;
      }
    }
    return best;
  };
  if (!taken('term')) {
    const i = pickMostFilled(FRONT_RE);
    if (i !== -1) roles[i] = 'term';
  }
  if (!taken('meaning') && !isCloze) {
    const i = pickMostFilled(BACK_RE);
    if (i !== -1) roles[i] = 'meaning';
  }
  for (let i = 0; i < count; i++) {
    if (undecided(i) && EX_RE.test(nameWords(names[i]))) roles[i] = 'example';
  }
  // 7a. Still no term or meaning (names nobody recognises, e.g. "Deutsch, Englisch"
  // from a CSV header): positions decide, as in the old importer. The term is the
  // first free field with values. The meaning is the first free field with values
  // on the ANSWER side of the first template, else the next free field with values.
  // Why the answer side first: a one-direction "English → German" verb deck asks
  // `{{Meaning}}` and a hint `{{CaseInfo}}` and answers `{{Verb}}`. The hint is on
  // the question side, so it is never the Back; Verb, the real answer, is.
  const order = first
    ? [...asked(first), ...first.prompt, ...first.answer, ...names.map((_, i) => i)]
    : names.map((_, i) => i);
  const freeWithValues = (k: number) => undecided(k) && fillOf(k) > 0;
  if (!taken('term')) {
    const i = order.find(freeWithValues) ?? order.find(undecided);
    if (i !== undefined) roles[i] = 'term';
  }
  if (!taken('meaning') && !isCloze) {
    const onAnswer = first ? first.answer.filter((k) => !first.prompt.includes(k)) : [];
    const i = onAnswer.find(freeWithValues) ?? order.find(freeWithValues);
    if (i !== undefined) roles[i] = 'meaning';
  }

  // Languages from {{tts}} (the first template that names one wins).
  const langOf = (i: number): string | undefined => {
    for (const t of type.templates) if (t.langs[i]) return t.langs[i];
    return undefined;
  };

  return names.map((name, i) => {
    const role: FieldRole = roles[i] ?? 'detail'; // 7. everything else
    const def: FieldDef = { name, role, facet: facetFor(role) };
    if (role === 'badge' && multiSep[i]) def.multiSep = multiSep[i];
    const lang = langOf(i);
    if (lang) def.lang = lang;
    const p = presetOf(i);
    if (!p) return def;
    // Presets win: their values replace the guessed ones.
    const out: FieldDef = { ...def, ...definedOnly(p), name };
    if (p.role && p.facet === undefined) out.facet = facetFor(p.role);
    if (p.role && p.role !== 'badge' && p.multiSep === undefined) delete out.multiSep;
    if (out.lang) out.lang = normalizeLang(out.lang) ?? out.lang;
    return out;
  });
}

/** Copy only the keys whose value is not undefined (an explicit undefined never wins). */
function definedOnly<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(o) as (keyof T)[]) {
    if (o[key] !== undefined) out[key] = o[key];
  }
  return out;
}

/* ---------------------------------------------------------- the mapping */

/** The import screen's starting guess for ONE source card type (spec §5.9 "Fields"). */
export interface TypeDraft {
  /** Source model id (the key of ImportChoices.types). */
  mid: string;
  name: string;
  kind: 'standard' | 'cloze';
  /** Anki `sortf`: the field for A–Z, the duplicate check and the quiz. */
  sortField: number;
  /** Notes of this card type in the collection ("German Vocabulary · 6,845 items"). */
  notes: number;
  /** The suggested field definitions, in field order. */
  fields: FieldDef[];
  /** The directions with these roles (badges left out of the sides). */
  templates: TemplateDef[];
  /** Enabled directions. Default: all (Anki behaviour). Cloze: every cloze number found − 1. */
  ords: number[];
  /** Per field: share of notes with a value, 0..1 ("MarankiExample (94% filled)"). An image or a sound is a value. */
  fill: number[];
  /** Per field: distinct folded values ("Level (5 values)"). */
  distinct: number[];
  /** The Front field (role term; the most-filled one if several), or -1. */
  term: number;
  /** The Back field (role meaning; the most-filled one if several), or -1. */
  meaning: number;
  /** Every example field, the most-filled first. */
  examples: number[];
  /** True when the guess is certain: exactly two fields, Front and Back by name. The Fields stage then collapses to one line. */
  certain: boolean;
}

export interface MappingDraft {
  /** One draft per source card type that has notes, the biggest first. */
  types: TypeDraft[];
}

/** Indexes with this role, the most-filled first (ties: field order). */
function byFill(fields: readonly FieldDef[], fill: readonly number[], role: FieldRole): number[] {
  return fields
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => f.role === role)
    .sort((a, b) => fill[b.i] - fill[a.i] || a.i - b.i)
    .map(({ i }) => i);
}

/** Roles of a CSV without a header: today's positions (0 term, 1 meaning, 2 example, 3 "Notes"). */
const CSV_POSITIONS: readonly FieldRole[] = ['term', 'meaning', 'example', 'detail'];

/**
 * The starting guess of the import screen (spec §5.1, §5.9), per source card
 * type of the collection that has notes:
 *   - field roles from inferFieldRoles (with the pack presets);
 *   - a CSV without a header keeps today's positions (0 term, 1 meaning,
 *     2 example, 3 detail "Notes"), so old files import the same way;
 *   - every direction on (Anki behaviour);
 *   - term / meaning / examples prefer the most-filled field.
 */
export function suggestMapping(
  collection: AnkiCollection,
  presets: readonly CardTypePreset[] = [],
): MappingDraft {
  const notesByMid = new Map<string, string[][]>();
  for (const note of collection.notes) {
    let rows = notesByMid.get(note.mid);
    if (!rows) {
      rows = [];
      notesByMid.set(note.mid, rows);
    }
    rows.push(note.flds);
  }
  const csvNoHeader = collection.csv !== undefined && collection.csv.header === null;

  const types: TypeDraft[] = [];
  for (const [mid, model] of Object.entries(collection.models)) {
    const rawRows = notesByMid.get(mid);
    if (!rawRows || rawRows.length === 0) continue;
    const names = modelFieldNames(model);
    const rows = rawRows.map((flds) => names.map((_, i) => flds[i] ?? ''));
    const parsed = parseModelTemplates(model);

    let fields = inferFieldRoles({ name: model.name, fieldNames: names, templates: parsed }, rows, presets);
    if (csvNoHeader) {
      fields = fields.map((f, i) => {
        const role = CSV_POSITIONS[i];
        if (!role) return f;
        const out: FieldDef = { name: f.name, role, facet: facetFor(role) };
        if (i === 3) out.label = 'Notes';
        if (f.lang) out.lang = f.lang;
        return out;
      });
    }

    const kind: TypeDraft['kind'] = model.type === 1 ? 'cloze' : 'standard';
    const templates = modelTemplates(model, fields);
    const fill = names.map((_, i) => fillShare(rows, i));
    const distinct = names.map((_, i) => new Set(rows.map((r) => foldValue(r[i])).filter((v) => v !== '')).size);

    let ords = templates.map((t) => t.ord);
    if (kind === 'cloze') {
      // One card per cloze number (cloze.ts: 1 or more, so an ord is never below 0), read
      // in the fields where renderFace hides deletions (render.clozeFields), as addNote does.
      const fromFields = clozeFields({ kind, fields, templates, sortField: model.sortf });
      const nums = new Set<number>();
      for (const row of rows) for (const i of fromFields) for (const n of clozeNumbers(row[i])) nums.add(n);
      ords = nums.size > 0 ? Array.from(nums, (n) => n - 1).sort((a, b) => a - b) : [0];
    }

    const term = byFill(fields, fill, 'term')[0] ?? -1;
    const meaning = byFill(fields, fill, 'meaning')[0] ?? -1;
    const certain =
      kind === 'standard' &&
      names.length === 2 &&
      term !== -1 &&
      meaning !== -1 &&
      FRONT_RE.test(nameWords(names[term])) &&
      BACK_RE.test(nameWords(names[meaning]));

    types.push({
      mid,
      name: model.name,
      kind,
      sortField: model.sortf >= 0 && model.sortf < names.length ? model.sortf : 0,
      notes: rows.length,
      fields,
      templates,
      ords,
      fill,
      distinct,
      term,
      meaning,
      examples: byFill(fields, fill, 'example'),
      certain,
    });
  }
  // The biggest card type first; same size → collection order (sort is stable).
  types.sort((a, b) => b.notes - a.notes);
  return { types };
}

/** The draft as ImportChoices.types: source model id → { fields, ords }. */
export function draftChoices(draft: MappingDraft): ImportChoices['types'] {
  const out: ImportChoices['types'] = {};
  for (const t of draft.types) out[t.mid] = { fields: t.fields.map((f) => ({ ...f })), ords: [...t.ords] };
  return out;
}

/* ------------------------------------------- the card type of a new card */

/** The card types every deck offers (the last rows of the card type picker): never a deck's "own" type. */
const PLAIN_TYPE_IDS: ReadonlySet<Id> = new Set([
  BUILTIN_TYPE_IDS.basic,
  BUILTIN_TYPE_IDS.basicReverse,
  BUILTIN_TYPE_IDS.cloze,
]);

/** What a deck says about the card type of its new cards: the setting, and whether the learner chose it. */
export type DeckTypeSetting = Pick<Deck, 'defaultTypeId' | 'defaultTypeChosen'>;

/**
 * The card type a NEW card in this deck starts with in the card editor
 * (spec §8.10; walkthrough L10), or null for "use Basic":
 *
 *   1. the deck's own setting when the learner chose one: `defaultTypeId`
 *      other than Basic (e.g. "Basic + reverse" from the deck editor), or
 *      a Basic that the deck editor saved as a choice (`defaultTypeChosen`);
 *   2. else, when the deck holds a card type of its OWN (one that is not
 *      Basic, Basic + reverse or Cloze — an imported German deck holds
 *      "German Vocabulary"), the card type most of the deck's items use;
 *      a tie goes to the name that comes first A–Z (the picker's order);
 *   3. else `defaultTypeId` (Basic), else null.
 *
 * Why a plain Basic in rule 1 does not count as a choice: every deck gets
 * `defaultTypeId: 'nt-basic'` when it is made (makeDeck), also an imported
 * one, so "Basic" there almost always means "nobody chose". Before this
 * rule a new card in the German deck started as Basic (Front / Back), not
 * as the deck's own card type with its fields. A Basic the learner picked
 * in the deck editor is different: the editor saves it with
 * `defaultTypeChosen: true`, and then it wins (wave 5c).
 *
 * `noteIds` = the ids of the deck's notes (fieldText.noteIdsInDeck). Only
 * card types that exist are counted (a stored one, or a built-in one).
 *
 *   newCardTypeId(german, notes, ids, types)   → 'nt-german-vocab'   (6,845 of 6,848 items)
 *   newCardTypeId({ ...german, defaultTypeChosen: true }, notes, ids, types)
 *                                              → 'nt-basic'          (the learner chose Basic)
 *   newCardTypeId(myDeck, notes, ids, types)   → 'nt-basic'          (made in the app, only Basic cards)
 */
export function newCardTypeId(
  deck: DeckTypeSetting | null | undefined,
  notes: readonly Pick<Note, 'id' | 'typeId'>[],
  noteIds: ReadonlySet<Id>,
  noteTypes: readonly Pick<NoteType, 'id' | 'name'>[],
): Id | null {
  return newCardTypeFromUses(deck, typeUses(notes, noteIds), noteTypes);
}

/**
 * The name of a card type that exists (a stored one, or a built-in one), or
 * null when `id` names no card type.
 */
function typeNameOf(noteTypes: readonly Pick<NoteType, 'id' | 'name'>[], id: Id): string | null {
  const stored = noteTypes.find((t) => t.id === id);
  if (stored) return stored.name;
  const kind = builtinKindOf(id);
  return kind ? builtinType(kind, 0).name : null;
}

/** How many of the deck's notes (`noteIds`) use each card type id. */
function typeUses(notes: readonly Pick<Note, 'id' | 'typeId'>[], noteIds: ReadonlySet<Id>): Map<Id, number> {
  const uses = new Map<Id, number>();
  for (const note of notes) {
    if (noteIds.has(note.id)) uses.set(note.typeId, (uses.get(note.typeId) ?? 0) + 1);
  }
  return uses;
}

/** A counted card type: its id, how many of the deck's notes use it, its name. */
interface TypeCount {
  id: Id;
  count: number;
  name: string;
}

/** The used card types that exist (a type id that names no card type is left out). */
function countedTypes(uses: ReadonlyMap<Id, number>, noteTypes: readonly Pick<NoteType, 'id' | 'name'>[]): TypeCount[] {
  return [...uses.entries()]
    .map(([id, count]) => ({ id, count, name: typeNameOf(noteTypes, id) }))
    .filter((x): x is TypeCount => x.name !== null);
}

/** Most used first; a tie goes to the name first A–Z (the picker's order), then to the id. */
function byUsesThenName(a: TypeCount, b: TypeCount): number {
  if (a.count !== b.count) return b.count - a.count;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** newCardTypeId with the uses already counted (deckCardTypeChoices uses them too). */
function newCardTypeFromUses(
  deck: DeckTypeSetting | null | undefined,
  uses: ReadonlyMap<Id, number>,
  noteTypes: readonly Pick<NoteType, 'id' | 'name'>[],
): Id | null {
  const chosen = deck?.defaultTypeId && typeNameOf(noteTypes, deck.defaultTypeId) !== null ? deck.defaultTypeId : null;
  // 1. A deliberate choice of the learner: any type but Basic, or a Basic the deck editor saved as a choice.
  if (chosen && (chosen !== BUILTIN_TYPE_IDS.basic || deck?.defaultTypeChosen === true)) return chosen;

  // 2. The deck's own card type: the most used one.
  const counted = countedTypes(uses, noteTypes);
  if (counted.some((x) => !PLAIN_TYPE_IDS.has(x.id))) {
    counted.sort(byUsesThenName);
    return counted[0].id;
  }

  // 3. The deck's setting (Basic), else the caller's Basic.
  return chosen;
}

/* ---------------------------------- the deck editor's "Card type" choices */

/** One choice of the deck editor's "Card type". */
export interface DeckTypeChoice {
  id: Id;
  /** The card type's name: "German Vocabulary (bidirectional)", "Basic + reverse". */
  name: string;
  /** How many of the deck's items (notes) use this card type now. */
  uses: number;
}

/** What the deck editor's "Card type" shows: the chosen value and the choices. */
export interface DeckTypeChoices {
  /** The card type new cards of the deck start with NOW: newCardTypeId, else Basic. */
  value: Id;
  /** The choices: each one takes effect when the deck editor saves it (see deckCardTypeChoices). Always holds `value`. */
  options: DeckTypeChoice[];
}

/**
 * The deck editor's "Card type" (spec §8.10): the value it shows and the
 * choices it offers. The value is EXACTLY the card type the card editor
 * starts a new card of this deck with (newCardTypeId, else Basic). So the
 * deck editor never says "Basic" while new cards start as the deck's own
 * card type (review of walkthrough L10).
 *
 * The choices, in this order:
 *   1. the deck's own card types (not Basic, Basic + reverse or Cloze), the
 *      most used first (a tie: the name first A–Z);
 *   2. the value, when it is none of the others (for example a Cloze setting);
 *   3. Basic, then Basic + reverse.
 * A type id that names no card type is never a choice.
 *
 * Every choice TAKES EFFECT when it is saved: the deck editor saves it as
 * the deck's `defaultTypeId` with `defaultTypeChosen: true`, and rule 1 of
 * newCardTypeId then gives exactly that type. Basic too (wave 5c): in an
 * imported German deck the learner can make Basic the card type of the new
 * cards. Before, a saved Basic looked like the Basic every deck gets when it
 * is made (makeDeck): it did nothing there, so it was not offered.
 *
 *   deckCardTypeChoices(germanDeck, …)              → value 'nt-vocab', options [German Vocabulary (bidirectional), Basic, Basic + reverse]
 *   deckCardTypeChoices(myBasicDeck, …)             → value 'nt-basic', options [Basic, Basic + reverse]
 *   deckCardTypeChoices(null, [], new Set(), types) → (a new deck) value 'nt-basic', options [Basic, Basic + reverse]
 */
export function deckCardTypeChoices(
  deck: DeckTypeSetting | null | undefined,
  notes: readonly Pick<Note, 'id' | 'typeId'>[],
  noteIds: ReadonlySet<Id>,
  noteTypes: readonly Pick<NoteType, 'id' | 'name'>[],
): DeckTypeChoices {
  const uses = typeUses(notes, noteIds);
  const value = newCardTypeFromUses(deck, uses, noteTypes) ?? BUILTIN_TYPE_IDS.basic;

  const own = countedTypes(uses, noteTypes)
    .filter((x) => !PLAIN_TYPE_IDS.has(x.id))
    .sort(byUsesThenName)
    .map((x) => x.id);
  // Basic and Basic + reverse always come last, in this order (whichever one is the value).
  const last = [BUILTIN_TYPE_IDS.basic, BUILTIN_TYPE_IDS.basicReverse];
  const candidates = [...own, ...(last.includes(value) ? [] : [value]), ...last];

  const options: DeckTypeChoice[] = [];
  const seen = new Set<Id>();
  for (const id of candidates) {
    if (seen.has(id)) continue;
    seen.add(id);
    const name = typeNameOf(noteTypes, id);
    // Only a card type that exists: a saved choice of it then takes effect (rule 1 of newCardTypeId).
    if (name === null) continue;
    options.push({ id, name, uses: uses.get(id) ?? 0 });
  }
  return { value, options };
}
