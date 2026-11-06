/**
 * The integrity check of the v3 note model (spec §3.5, unit W2-8): it finds
 * and repairs broken LINKS between card types, notes, cards and decks, so
 * every screen can trust them. Pure: no I/O, and the clock comes in as `now`.
 *
 * WIRED (W3-1): `migrate()` (src/store/migrate.ts) calls it on every v3
 * document — right after v2toV3 for an old one — so it runs on every load
 * and on every restore. The exact order of the whole chain, and why, is
 * written in the file comment of src/store/migrate.ts. When `repaired` is
 * not empty, Today shows once: "We fixed {n} items in your library."
 *
 * The repairs of spec §3.5 (each one is one readable line in `repaired`):
 *   1. a card whose note is missing → set aside: it is left out of
 *      `state.cards`. (The row store never deletes a row it did not load, so
 *      the row stays on disk.)
 *   2. a note with no cards → kept as it is (Directions can give it cards again).
 *   3. the cards of one note in different decks → all move to the deck of the
 *      lowest-ord card ("one item, one deck").
 *   4. a card whose deck is missing → the "Unfiled cards" deck (made when needed).
 *   5. a note whose card type is missing → a "Recovered" card type with the
 *      fields "Field 1" … "Field N" (the first is the term, the rest details).
 *   6. two cards for the same (note, direction) → the first is kept.
 *   7. a note with fewer values than its card type has fields → padded with
 *      ''; with more → the extra values move into a "Recovered" field.
 *
 * Small refinements of those rules (all keep more of the learner's data):
 *   - rule 3+4 together: the "lowest-ord card" is the lowest-ord card whose
 *     deck EXISTS, so one card with a deleted deck joins its siblings instead
 *     of pulling them all into Unfiled;
 *   - rule 5: a missing BUILT-IN type ('nt-basic' …) is a code constant, so
 *     it is added again as itself (names, roles, directions), not as "Recovered";
 *   - two notes (or two cards, or two decks) with the same id: the second one
 *     gets a new id ('<id>~2') instead of being thrown away. The new id is
 *     never an id that another entry of the list already has (that entry
 *     keeps it, and so do the links to it);
 *   - rule 6 + two notes with one id: the cards still point at the OLD id.
 *     When a card's direction is already taken on the first note, the card
 *     moves to the next copy of that note ('<id>~2', '<id>~3' …) that does
 *     not have that direction yet. So the second note keeps a card, and the
 *     card keeps its progress; only a card with no free copy is removed;
 *   - a deck with no usable id gets 'deck-repaired-<index>' (the same rule
 *     as `sanitize`);
 *   - the note shape the checks read is repaired too: `typeId`, `fields`
 *     (a list of texts; a `fields` value that is not a list keeps its text,
 *     for example 'Hund' → ['Hund']), `tags`, `section`, `guid`. A tag or a
 *     section that is not a text KEEPS what it holds, as text (see tagsFrom
 *     and sectionFrom): `tags: ['ok', 3]` → ['ok', '3'], `section: ['Verbs',
 *     'B1']` → 'Verbs::B1';
 *   - a card whose direction (`ord`) is not a whole number ≥ 0 gets the
 *     lowest direction that no other card of its note uses, so it keeps its
 *     progress and never takes the place of a sibling (see freeOrds);
 *   - the deck options the scheduler reads are repaired too: `options` that
 *     is not an object → the defaults; a `directions` entry that is not a
 *     list of directions → removed (every direction on), so one damaged deck
 *     can never break the Study counts (see repairDeckOptions);
 *   - the templates renderFace reads are repaired too, so one damaged
 *     template can never break the cards of its type: a template that is
 *     not an object or has no usable direction → removed; a `prompt` /
 *     `answer` that is not a list of field numbers → its field numbers (when
 *     none is left: the sort field asks, every other field answers); and a
 *     card type with no template left → one "Card <n>" template per
 *     direction its cards use, or the built-in templates for a built-in
 *     type (see repairTemplates, recoveredTemplates);
 *   - a damaged card type is REPAIRED, not removed, so its field names,
 *     roles and filter groups (for example "Level") survive one bad value
 *     (see repairTypeShape): `templates` that is not a list → [] (then the
 *     templates rule above); a field that is not an object or has no text
 *     name → "Field <n>" (the built-in field for a built-in type); a field
 *     `label` / `lang` / `multiSep` of the wrong kind → removed; a field
 *     `role` / `facet` of the wrong kind → 'detail' / 'auto'; `fields` that
 *     is not a list → "Field 1" … "Field N" (N = the most values one of its
 *     notes has; the built-in fields for a built-in type); `name`, `kind`,
 *     `sortField`, `createdAt`, `updatedAt` of the wrong kind → a default.
 *     Only an entry that is not an object, or has no usable id, is removed.
 *
 * Rules every repair keeps:
 *   - Repair, never drop text. Every note text stays. Only these are left
 *     out: a card without a note (rule 1), the second card for one direction
 *     when no copy of its note is free (rule 6), a template that no card can
 *     find (no usable direction), a card type with no usable id (no note can
 *     point at it) or a second card type with the same id, and list entries
 *     that are not objects at all.
 *   - An object that needs no repair keeps its IDENTITY, and an intact state
 *     comes back as the very same object: the wave-3 row diff compares by
 *     identity, so an intact library writes nothing.
 *   - Idempotent: checking the result again finds nothing.
 *
 * Example (`migrate()` runs this whole chain itself; the schema-2 stage is
 * `migrateToV2()`, and `v2toV3` takes ITS result, never a v3 state):
 *   const out = migrateToV2(storedDoc, now);   // any old document → schema 2, repaired
 *   if (out.kind === 'ok') {
 *     const { state, repaired } = checkIntegrity(v2toV3(out.state, now), now);
 *     if (repaired.length > 0) showOnce(`We fixed ${plural(repaired.length, 'item')} in your library.`);
 *   }
 */
import { builtinKindOf, builtinType } from '../domain/builtinTypes';
import { fieldKey } from '../domain/libraryIndex';
import { DEFAULT_DECK_OPTIONS } from '../domain/makeV3';
import type { Card, DataStateV3, Deck, FieldDef, FieldRole, Note, NoteType, TemplateDef } from '../domain/model';
import { plural } from '../domain/text';
import { UNFILED_DECK_ID, unfiledDeck } from './deckOps';

export interface IntegrityResult {
  /** The repaired state (the SAME object when nothing needed a repair). */
  state: DataStateV3;
  /** One readable line per repair, e.g. 'card "c1": deckId "d9" → "unfiled" (its deck is missing)'. */
  repaired: string[];
}

/** The name of a card type made for notes whose own type is missing (rule 5). */
export const RECOVERED_TYPE_NAME = 'Recovered';
/** The id of the Recovered type for notes that have no usable `typeId` at all. */
export const RECOVERED_TYPE_ID = 'nt-recovered';
/** The field that keeps the values a note has beyond its type's fields (rule 7). */
export const RECOVERED_FIELD_NAME = 'Recovered';
/** The name of a card type whose stored name is not a text (and not a number or true/false). */
export const DEFAULT_TYPE_NAME = 'Card type';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const isId = (v: unknown): v is string => isString(v) && v !== '';
const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** A direction number: a whole number ≥ 0. */
const isOrd = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** A value as a short readable text for the repair list. A missing key is "missing". */
function show(v: unknown): string {
  if (v === undefined) return 'missing';
  if (typeof v === 'number') return String(v);
  return JSON.stringify(v) ?? String(v);
}

/**
 * Any stored value as the text of ONE note field, keeping what it holds:
 * a text stays as it is; null / undefined → ''; an object or a list → its
 * JSON (so its words are still there); a number or true/false → its text.
 *
 *   textOf('Hund') → 'Hund'   textOf(42) → '42'   textOf(null) → ''   textOf({a: 'x'}) → '{"a":"x"}'
 */
function textOf(v: unknown): string {
  if (isString(v)) return v;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v) ?? '';
  return String(v);
}

/** The Anki field separator: Anki stores all field values of a note in ONE text, joined by it. */
const ANKI_FIELD_SEPARATOR = '\x1f';

/**
 * A `fields` value that is NOT a list → the list of its texts, so no text is
 * lost (rule "repair, never drop"). The note's type then decides the count:
 * alignFields pads the list or moves the extra values (rule 7).
 *   - a text → split on the Anki field separator (one value when it has none);
 *   - an object → its values, in key order (a number key first, like JSON);
 *   - null / undefined → no values;
 *   - anything else (a number, true/false) → one value, as text.
 *
 *   fieldsFromNonList('Hund')                    → ['Hund']
 *   fieldsFromNonList('Hund\x1fdog')             → ['Hund', 'dog']
 *   fieldsFromNonList({ Front: 'Hund', Back: 'dog' }) → ['Hund', 'dog']
 *   fieldsFromNonList(7)                         → ['7']
 */
function fieldsFromNonList(v: unknown): string[] {
  if (isString(v)) return v.split(ANKI_FIELD_SEPARATOR);
  if (v === null || v === undefined) return [];
  if (isObj(v)) return Object.values(v).map(textOf);
  return [textOf(v)];
}

/**
 * Any stored `tags` value → a list of tag texts, KEEPING every word it holds
 * (rule "repair, never drop"):
 *   - a text inside the list stays as it is (one whole tag);
 *   - a number or true/false inside the list → its text;
 *   - a list or an object inside the list → its items / values, the same way;
 *   - null / undefined, and empty texts made by the repair → no tag;
 *   - `tags` that is ONE text → split on white space, the way Anki stores
 *     the tags of a note ('verb A1' → ['verb', 'A1']);
 *   - `tags` that is a number, true/false or an object → as inside a list.
 *
 *   tagsFrom(['ok', 3])       → ['ok', '3']
 *   tagsFrom('verb  A1')      → ['verb', 'A1']
 *   tagsFrom(['a', ['b', 7]]) → ['a', 'b', '7']
 *   tagsFrom(null)            → []
 */
export function tagsFrom(v: unknown): string[] {
  if (isString(v)) return v.split(/\s+/).filter((t) => t !== '');
  return tagItems(v);
}

/** The tags of one value INSIDE a tags list (a text there is one whole tag). */
function tagItems(v: unknown): string[] {
  if (isString(v)) return [v];
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v.flatMap(tagItems).filter((t) => t !== '');
  if (isObj(v)) return Object.values(v).flatMap(tagItems).filter((t) => t !== '');
  return [String(v)];
}

/** The Anki subdeck separator: a section is the path below the deck root, 'Verbs::B1'. */
const SECTION_SEPARATOR = '::';

/**
 * Any stored `section` value → a section text, KEEPING what it holds:
 *   - null / undefined → '' (the deck root: there is nothing to keep);
 *   - a list of path levels → joined with '::' (['Verbs', 'B1'] → 'Verbs::B1');
 *   - an object → its values, joined the same way;
 *   - a number or true/false → its text.
 *
 *   sectionFrom(['Verbs', 'B1']) → 'Verbs::B1'   sectionFrom(12) → '12'   sectionFrom(null) → ''
 */
function sectionFrom(v: unknown): string {
  if (isString(v)) return v;
  if (v === null || v === undefined) return '';
  if (!Array.isArray(v) && !isObj(v)) return String(v);
  const parts: unknown[] = Array.isArray(v) ? v : Object.values(v);
  return parts
    .map(sectionFrom)
    .filter((p) => p !== '')
    .join(SECTION_SEPARATOR);
}

/** `${base}~2`, `${base}~3` … — the first one not in `used`. */
function freshId(base: string, used: ReadonlySet<string>): string {
  let k = 2;
  while (used.has(`${base}~${k}`)) k += 1;
  return `${base}~${k}`;
}

/**
 * Hands out one unique id per entry of a list. The first entry with an id
 * keeps it. A later entry with the same id gets a fresh id ('<id>~2' …) that
 * NO entry of the list has, so it never takes the id of a later entry (and
 * the links that point at that entry stay right).
 *
 *   const idFor = uniqueIds(['n1', 'n1', 'n1~2']);
 *   idFor('n1') → 'n1'    idFor('n1') → 'n1~3'    idFor('n1~2') → 'n1~2'
 */
function uniqueIds(ownIds: readonly unknown[]): (own: string) => string {
  const taken = new Set(ownIds.filter(isString));
  const given = new Set<string>();
  return (own) => {
    const id = given.has(own) ? freshId(own, taken) : own;
    given.add(id);
    taken.add(id);
    return id;
  };
}

/** The ids of the entries of a list that are objects (other values are skipped). */
const idsOf = (list: readonly unknown[]): unknown[] => list.filter(isObj).map((x) => x.id);

/** True when both lists hold the same items, in the same order (by identity). */
function sameItems(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * A copy-on-write helper for one stored object: the object is copied only on
 * the first repair (an intact object keeps its identity), and each repair is
 * written as one line "<label>: <key> <old> → <new>" (or "… removed").
 *
 *   const r = copyOnWrite(field, 'card type "t1", field "Level"', repaired);
 *   r.remove('label');   // line: 'card type "t1", field "Level": label 5 removed'
 *   r.result();          // the copy (or the same object when nothing was repaired)
 */
function copyOnWrite(obj: Obj, label: string, repaired: string[]) {
  let copy: Obj | null = null;
  const writable = (): Obj => (copy = copy ?? { ...obj });
  return {
    set(key: string, value: unknown) {
      repaired.push(`${label}: ${key} ${show(obj[key])} → ${show(value)}`);
      writable()[key] = value;
    },
    /** Set a value WITHOUT a line: the caller already wrote its own line. */
    put(key: string, value: unknown) {
      writable()[key] = value;
    },
    remove(key: string) {
      repaired.push(`${label}: ${key} ${show(obj[key])} removed`);
      delete writable()[key];
    },
    get(key: string): unknown {
      return (copy ?? obj)[key];
    },
    result(): Obj {
      return copy ?? obj;
    },
  };
}

/* ------------------------------------------------------------ card types */

/** A field number of a card type with `fieldCount` fields: a whole number from 0 to fieldCount − 1. */
const isFieldIndex = (v: unknown, fieldCount: number): v is number => isOrd(v) && v < fieldCount;

/** Every FieldRole (a record, so TypeScript checks that the list is complete). */
const FIELD_ROLES: Readonly<Record<FieldRole, true>> = {
  term: true,
  meaning: true,
  example: true,
  exampleMeaning: true,
  pronunciation: true,
  detail: true,
  badge: true,
  hidden: true,
};
/** hasOwnProperty, not `in`: 'constructor' must not count as a role. */
const isFieldRole = (v: unknown): v is FieldRole => isString(v) && Object.prototype.hasOwnProperty.call(FIELD_ROLES, v);
/** The three `FieldDef.facet` values. */
const FACET_MODES: readonly unknown[] = ['auto', 'on', 'off'];
/** The three `FieldDef.multiSep` values. */
const MULTI_SEPS: readonly unknown[] = [',', ';', '|'];

/** The built-in card type with this id ('nt-basic' …), or null for any other id. */
function builtinFor(typeId: string, now: number): NoteType | null {
  const kind = builtinKindOf(typeId);
  return kind ? builtinType(kind, now) : null;
}

/** The fields "Field 1" … "Field N" of a card type whose own fields are unknown: the first is the term, the others details. */
function recoveredFields(count: number): FieldDef[] {
  const fields: FieldDef[] = [];
  for (let i = 0; i < count; i++) {
    fields.push({ name: `Field ${i + 1}`, role: i === 0 ? 'term' : 'detail', facet: 'auto' });
  }
  return fields;
}

/**
 * A field name that no other field of the type has (compared like the filter
 * groups compare names, so 'field 2' and 'Field 2' are the same name). It is
 * added to `used`.
 *
 *   freshFieldName('Field 2', used with 'field 2') → 'Field 2 (2)'
 */
function freshFieldName(base: string, used: Set<string>): string {
  let name = base;
  for (let k = 2; used.has(fieldKey(name)); k++) name = `${base} (${k})`;
  used.add(fieldKey(name));
  return name;
}

/**
 * One entry of `fields`, repaired copy-on-write (an intact field keeps its
 * identity). See repairFields for the rules.
 */
function repairField(f: unknown, i: number, ctx: FieldCtx): FieldDef {
  const own = ctx.builtin?.fields[i];
  // The name a damaged field gets: the built-in field's name, or "Field <i + 1>" (always unique).
  const newName = () =>
    own && !ctx.used.has(fieldKey(own.name)) ? freshFieldName(own.name, ctx.used) : freshFieldName(`Field ${i + 1}`, ctx.used);
  if (!isObj(f)) {
    const name = newName();
    const def: FieldDef = own && own.name === name ? { ...own } : { name, role: 'detail', facet: 'auto' };
    ctx.repaired.push(`${ctx.label}, field #${i}: ${show(f)} is not a field → ${show(def)}`);
    return def;
  }
  const r = copyOnWrite(f, isString(f.name) ? `${ctx.label}, field ${JSON.stringify(f.name)}` : `${ctx.label}, field #${i}`, ctx.repaired);
  if (!isString(f.name)) r.set('name', newName());
  for (const key of ['label', 'lang']) {
    if (f[key] !== undefined && !isString(f[key])) r.remove(key);
  }
  if (!isFieldRole(f.role)) r.set('role', 'detail');
  if (!FACET_MODES.includes(f.facet)) r.set('facet', 'auto');
  if (f.multiSep !== undefined && !MULTI_SEPS.includes(f.multiSep)) r.remove('multiSep');
  return r.result() as unknown as FieldDef;
}

/** What repairField needs to know about its card type. */
interface FieldCtx {
  /** 'card type "<id>"', the start of every repair line. */
  label: string;
  /** The built-in card type with the same id, or null. */
  builtin: NoteType | null;
  /** The folded names the fields already have (fieldKey); new names are added. */
  used: Set<string>;
  repaired: string[];
}

/**
 * The `fields` of a card type, repaired. Returns the SAME list when nothing
 * is wrong (an intact type keeps its identity), else a new one:
 *   - `fields` that is not a list → the built-in fields for a built-in type,
 *     else "Field 1" … "Field N" (N = `valueCount`, the most values one of
 *     its notes has; at least 1). Rule 7 then fits every note to them;
 *   - an entry that is not an object → a new field: the built-in field at
 *     that place for a built-in type, else "Field <i + 1>" (role 'detail',
 *     filter group decided by the data rule);
 *   - a `name` that is not a text → the same new name (always unique);
 *   - `label`, `lang` that are not texts → removed (the UI shows the name;
 *     read aloud uses the deck language);
 *   - `role` that is not a FieldRole → 'detail' (a labelled row on the answer);
 *   - `facet` that is not 'auto' / 'on' / 'off' → 'auto';
 *   - `multiSep` that is not ',' / ';' / '|' → removed.
 *
 * WHY: the library index and the filter groups read every field of every
 * card type (`(def.label ?? def.name).trim()`, `lang.split('-')`). One bad
 * value (a hand-edited or half-broken backup) must not break every screen
 * that filters — and must not cost the type its OTHER fields: the "Level"
 * filter group survives a damaged "Notes" field.
 *
 *   [Front, null, { name: 'Level', role: 'badge', facet: 'on', label: 5 }]
 *     → [Front, { name: 'Field 2', role: 'detail', facet: 'auto' }, { name: 'Level', role: 'badge', facet: 'on' }]
 */
function repairFields(fieldsIn: unknown, valueCount: number, ctx: FieldCtx): FieldDef[] {
  if (!Array.isArray(fieldsIn)) {
    const fields = ctx.builtin ? ctx.builtin.fields : recoveredFields(Math.max(1, valueCount));
    const what = ctx.builtin ? 'the built-in fields' : `${plural(fields.length, 'field')} "Field 1" … "Field ${fields.length}"`;
    ctx.repaired.push(`${ctx.label}: fields ${show(fieldsIn)} is not a list of fields → ${what}`);
    return fields;
  }
  for (const f of fieldsIn) if (isObj(f) && isString(f.name)) ctx.used.add(fieldKey(f.name));
  const fields = fieldsIn.map((f, i) => repairField(f, i, ctx));
  return sameItems(fieldsIn, fields) ? (fieldsIn as FieldDef[]) : fields;
}

/**
 * A card type with a usable id, repaired copy-on-write (an intact type keeps
 * its identity): every value the screens read, so one bad value can never
 * cost the type its fields, roles and filter groups (spec §3.1 rule 4,
 * "repair, never drop"):
 *   - `name` that is not a text → the built-in name for a built-in type; a
 *     number or true/false → its text; anything else → "Card type";
 *   - `kind` that is not 'standard' / 'cloze' → the built-in kind, or 'standard';
 *   - `fields` → see repairFields;
 *   - `templates` that is not a list → [] (repairTemplates and step 6 then
 *     give the type its templates back);
 *   - `sortField` that is not a field number → 0 (the first field);
 *   - `createdAt` not finite → now; `updatedAt` not finite → createdAt.
 * `valueCount` is the most values one note of this type has (for `fields`
 * that is not a list).
 *
 *   { id: 'nt-anki-1', name: 5, fields: [Front, Back, Level], templates: null, sortField: 9 }
 *     → { id: 'nt-anki-1', name: '5', fields: [Front, Back, Level], templates: [], sortField: 0 }
 */
function repairTypeShape(t: Obj & { id: string }, valueCount: number, now: number, repaired: string[]): NoteType {
  const label = `card type "${t.id}"`;
  const builtin = builtinFor(t.id, now);
  const r = copyOnWrite(t, label, repaired);
  if (!isString(t.name)) {
    const scalar = typeof t.name === 'number' || typeof t.name === 'boolean';
    r.set('name', builtin?.name ?? (scalar ? String(t.name) : DEFAULT_TYPE_NAME));
  }
  if (t.kind !== 'standard' && t.kind !== 'cloze') r.set('kind', builtin?.kind ?? 'standard');
  const fields = repairFields(t.fields, valueCount, { label, builtin, used: new Set<string>(), repaired });
  if (fields !== t.fields) r.put('fields', fields);
  if (!Array.isArray(t.templates)) r.set('templates', []);
  if (!(isFieldIndex(t.sortField, fields.length) || (fields.length === 0 && t.sortField === 0))) r.set('sortField', 0);
  if (!isFiniteNum(t.createdAt)) r.set('createdAt', now);
  if (!isFiniteNum(t.updatedAt)) r.set('updatedAt', r.get('createdAt'));
  return r.result() as unknown as NoteType;
}

/**
 * The most values one note has, per card type id (the notes as stored, before
 * the note repairs: a `fields` value that is not a list counts its texts).
 * A card type whose own `fields` is not a list gets that many fields.
 */
function valueCounts(notesIn: readonly unknown[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const n of notesIn) {
    if (!isObj(n) || !isId(n.typeId)) continue;
    const count = Array.isArray(n.fields) ? n.fields.length : fieldsFromNonList(n.fields).length;
    out.set(n.typeId, Math.max(out.get(n.typeId) ?? 0, count));
  }
  return out;
}

/**
 * The question side of a card with no usable template — the same rule as
 * renderFace: the sort field asks (the first field when the sort field is
 * not a field of the type). A type with no field has no question field.
 *
 *   askSide(4, 1) → [1]    askSide(4, 'x') → [0]    askSide(0, 0) → []
 */
function askSide(fieldCount: number, sortField: unknown): number[] {
  if (fieldCount === 0) return [];
  return [isFieldIndex(sortField, fieldCount) ? sortField : 0];
}

/** The answer side that goes with a question side: every other field, in order. otherFields(4, [1]) → [0, 2, 3] */
function otherFields(fieldCount: number, prompt: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < fieldCount; i++) if (!prompt.includes(i)) out.push(i);
  return out;
}

/**
 * The templates for a card type that has none (rule 5, and a type whose
 * templates were all damaged): one template per direction its cards use
 * ("Card 1", "Card 3" …; direction 0 when no card uses one). The sort field
 * asks and every other field answers (askSide).
 *
 *   recoveredTemplates(4, 0, [2, 0, 2]) → [{ ord: 0, name: 'Card 1', prompt: [0], answer: [1, 2, 3] },
 *                                         { ord: 2, name: 'Card 3', prompt: [0], answer: [1, 2, 3] }]
 */
function recoveredTemplates(fieldCount: number, sortField: unknown, ords: readonly number[]): TemplateDef[] {
  const prompt = askSide(fieldCount, sortField);
  const answer = otherFields(fieldCount, prompt);
  const usedOrds = ords.length > 0 ? [...new Set(ords)].sort((a, b) => a - b) : [0];
  return usedOrds.map((ord) => ({ ord, name: `Card ${ord + 1}`, prompt: [...prompt], answer: [...answer] }));
}

/**
 * A "Recovered" card type (rule 5) for notes whose type is missing:
 * `fieldCount` fields "Field 1" … "Field N" (the first one is the term, the
 * others are detail rows; filter groups decided by the data rule), and one
 * template per direction its cards use ("Card 1", "Card 2" …), each showing
 * the first field and answering with the others.
 */
function recoveredType(id: string, fieldCount: number, ords: readonly number[], now: number): NoteType {
  const n = Math.max(1, fieldCount);
  const fields = recoveredFields(n);
  const templates = recoveredTemplates(n, 0, ords);
  return { id, name: RECOVERED_TYPE_NAME, kind: 'standard', fields, templates, sortField: 0, createdAt: now, updatedAt: now };
}

/**
 * One side of a template (`prompt` or `answer`: field numbers, in order),
 * repaired. Returns null when it is a list of field numbers (nothing to do;
 * an EMPTY list is fine too: nothing on that side). Else the field numbers it
 * holds, and when it holds none, `fallback()`.
 *
 *   repairSide([0, 'a', 9], 4, f) → [0]     repairSide(5, 4, () => [1, 2]) → [1, 2]     repairSide([1], 4, f) → null
 */
function repairSide(side: unknown, fieldCount: number, fallback: () => number[]): number[] | null {
  if (Array.isArray(side) && side.every((i) => isFieldIndex(i, fieldCount))) return null;
  const kept = Array.isArray(side) ? side.filter((i): i is number => isFieldIndex(i, fieldCount)) : [];
  return kept.length > 0 ? kept : fallback();
}

/**
 * One template whose `ord` is a direction, repaired copy-on-write (an intact
 * template keeps its identity). See repairTemplates for the rules.
 */
function repairTemplate(t: Obj, ord: number, type: NoteType, repaired: string[]): TemplateDef {
  const fieldCount = type.fields.length;
  const r = copyOnWrite(t, `card type "${type.id}", direction ${ord}`, repaired);

  if (!isString(t.name)) r.set('name', `Card ${ord + 1}`);
  const prompt = repairSide(t.prompt, fieldCount, () => askSide(fieldCount, type.sortField));
  if (prompt) r.set('prompt', prompt);
  // The answer that goes with the question side as it is NOW (repaired or not).
  const promptNow = prompt ?? (t.prompt as number[]);
  const answer = repairSide(t.answer, fieldCount, () => otherFields(fieldCount, promptNow));
  if (answer) r.set('answer', answer);
  if (t.typeField !== undefined && !isFieldIndex(t.typeField, fieldCount)) r.remove('typeField');
  for (const key of ['qfmt', 'afmt']) {
    if (t[key] !== undefined && !isString(t[key])) r.remove(key);
  }
  return r.result() as unknown as TemplateDef;
}

/**
 * The templates of a usable card type, repaired. Returns the SAME type when
 * nothing is wrong (an intact type keeps its identity), else a copy:
 *   - an entry that is not an object, or whose `ord` (its direction) is not
 *     a whole number ≥ 0 → removed (no card can find it);
 *   - `prompt` / `answer` that is not a list of field numbers (a whole number
 *     from 0 to the field count − 1) → only its field numbers are kept; when
 *     none is left, the side renderFace shows for a type with no template:
 *     the sort field asks (askSide), every other field answers (otherFields);
 *   - `name` that is not a text → "Card <ord + 1>";
 *   - `typeField` that is not a field number → removed (no typing target);
 *   - `qfmt`, `afmt` (the raw Anki templates) that are not texts → removed.
 * A type with NO template left gets "Card <n>" templates in checkIntegrity
 * step 6 (recoveredTemplates needs the directions of its cards).
 *
 * WHY: renderFace, the filter groups and addNote read every template of a
 * type (`t.ord`, `t.prompt[0]`, `for (i of t.answer)`). One damaged template
 * (a hand-edited or half-broken backup) must not break every card of the type.
 *
 *   Basic (4 fields), templates [null, { ord: 0, name: 'A', prompt: [0], answer: 5 }]
 *     → templates [{ ord: 0, name: 'A', prompt: [0], answer: [1, 2, 3] }]
 */
function repairTemplates(type: NoteType, repaired: string[]): NoteType {
  const label = `card type "${type.id}"`;
  const templates: TemplateDef[] = [];
  (type.templates as unknown[]).forEach((t, i) => {
    if (!isObj(t)) {
      repaired.push(`${label}: template #${i} ${show(t)} is not a template, removed`);
    } else if (!isOrd(t.ord)) {
      repaired.push(`${label}: template #${i} has no usable direction (ord ${show(t.ord)}), removed`);
    } else {
      templates.push(repairTemplate(t, t.ord, type, repaired));
    }
  });
  return sameItems(type.templates, templates) ? type : { ...type, templates };
}

/* ------------------------------------------------------------------ notes */

/**
 * The note shape the checks read, repaired copy-on-write (an intact note
 * keeps its identity): `typeId` (no usable id → the Recovered type),
 * `fields` (a list of texts — a value that is not a list keeps its text, see
 * fieldsFromNonList), `tags` (a list of texts, see tagsFrom), `section` (a
 * text, see sectionFrom) and `guid`.
 */
function repairNoteShape(note: Obj, id: string, repaired: string[]): Note {
  let copy: Obj | null = null;
  const set = (key: string, value: unknown, line: string) => {
    repaired.push(`note "${id}": ${line}`);
    copy = copy ?? { ...note };
    copy[key] = value;
  };
  if (note.id !== id) set('id', id, `id ${show(note.id)} → "${id}"`);
  if (!isId(note.typeId)) set('typeId', RECOVERED_TYPE_ID, `typeId ${show(note.typeId)} → "${RECOVERED_TYPE_ID}"`);
  if (!Array.isArray(note.fields)) {
    const fields = fieldsFromNonList(note.fields);
    set('fields', fields, `fields ${show(note.fields)} → ${show(fields)}`);
  } else if (!note.fields.every(isString)) {
    set('fields', note.fields.map(textOf), 'field values that were not texts became texts');
  }
  if (!(Array.isArray(note.tags) && note.tags.every(isString))) {
    const tags = tagsFrom(note.tags);
    set('tags', tags, `tags ${show(note.tags)} → ${show(tags)}`);
  }
  if (!isString(note.section)) {
    const section = sectionFrom(note.section);
    set('section', section, `section ${show(note.section)} → ${show(section)}`);
  }
  if (!isId(note.guid)) set('guid', `m-${id}`, `guid ${show(note.guid)} → "m-${id}"`);
  return (copy ?? note) as unknown as Note;
}

/**
 * Rule 7 for every note of one card type. Returns the type (a new object
 * when a "Recovered" field was added) and writes the aligned notes into
 * `notes` (by index).
 *
 *   - fewer values than fields → padded with '' (listed);
 *   - more values → the extra values that are not empty go, one per line
 *     (`<br>`), into the type's "Recovered" field, which is added at the
 *     end of the type when it does not exist yet (listed once for the type,
 *     and once for EVERY note whose values moved — also a note with exactly
 *     one extra value, whose list already has the new length);
 *     extra values that are all empty are just removed (listed).
 * Notes that only get an empty value for a newly added "Recovered" field are
 * changed without a line: the type's line explains it.
 *
 * Whether a note is listed is decided by comparing its value count with the
 * OLD field count (`oldN`): that is the count the note did not fit.
 */
function alignFields(type: NoteType, noteIndexes: readonly number[], notes: Note[], now: number, repaired: string[]): NoteType {
  const oldN = type.fields.length;
  const extrasOf = (note: Note) => note.fields.slice(oldN).filter((v) => v !== '');
  const needsRecovered = noteIndexes.some((i) => extrasOf(notes[i]).length > 0);

  let outType = type;
  let recoveredAt = type.fields.findIndex((f) => f.name === RECOVERED_FIELD_NAME);
  if (needsRecovered && recoveredAt === -1) {
    recoveredAt = oldN;
    outType = {
      ...type,
      fields: [...type.fields, { name: RECOVERED_FIELD_NAME, role: 'detail', facet: 'off' }],
      updatedAt: now,
    };
    repaired.push(`card type "${type.id}": a "${RECOVERED_FIELD_NAME}" field was added for values that had no field`);
  }
  const n = outType.fields.length;

  for (const i of noteIndexes) {
    const note = notes[i];
    const values = note.fields;
    // It fits the type as it was, and the type got no new field: nothing to do.
    if (values.length === oldN && n === oldN) continue;
    const head = values.slice(0, oldN);
    while (head.length < n) head.push('');
    const extras = extrasOf(note);
    if (extras.length > 0) head[recoveredAt] = [head[recoveredAt], ...extras].filter((v) => v !== '').join('<br>');
    if (values.length < oldN) {
      repaired.push(`note "${note.id}": ${values.length} values for ${oldN} fields, padded with empty values`);
    } else if (extras.length > 0) {
      repaired.push(
        `note "${note.id}": ${values.length} values for ${oldN} fields, the extra values moved to the "${RECOVERED_FIELD_NAME}" field`,
      );
    } else if (values.length > n) {
      repaired.push(`note "${note.id}": ${values.length} values for ${oldN} fields, the empty extra values removed`);
    }
    // Example: Basic note ['a','b','','','EXTRA'] and a new "Recovered" field:
    // the values are already in the right places, so the note keeps its identity.
    const same = head.length === values.length && head.every((v, k) => v === values[k]);
    if (!same) notes[i] = { ...note, fields: head };
  }
  return outType;
}

/* ------------------------------------------------------------------ decks */

/**
 * The deck options the scheduler reads, repaired. Returns the SAME object
 * when nothing is wrong (so an intact deck keeps its identity), else a new one:
 *   - `options` that is not an object → the default options;
 *   - `options.directions` (card type → the directions that are on) that is
 *     not an object → removed: no map = every direction is on;
 *   - one entry that is not a list of directions (for example `1` or `null`)
 *     → removed: no entry = every direction of that card type is on;
 *   - a list with values that are not directions (a direction is a whole
 *     number ≥ 0) → only the directions are kept; when none is left, the
 *     entry is removed (like a broken entry).
 * A list with NO values (`[]`) is not damaged: it means "every direction is
 * off", so it is kept.
 *
 * WHY: the scheduler calls `ords.includes(card.ord)` on the entry of every
 * card, and it runs for every Study count on every screen. One damaged deck
 * (a hand-edited or half-broken backup) must not break all of them.
 *
 *   { directions: { 'nt-basic-reverse': 1 } }        → { directions: {} }
 *   { directions: { 'nt-basic-reverse': [0, 'x'] } } → { directions: { 'nt-basic-reverse': [0] } }
 */
function repairDeckOptions(options: unknown, label: string, repaired: string[]): unknown {
  if (!isObj(options)) {
    repaired.push(`${label}: options ${show(options)} → the default options`);
    return { ...DEFAULT_DECK_OPTIONS };
  }
  const directions = options.directions;
  if (directions === undefined) return options;
  if (!isObj(directions)) {
    repaired.push(`${label}: options.directions ${show(directions)} removed (every direction is on)`);
    const rest: Obj = { ...options };
    delete rest.directions;
    return rest;
  }
  let fixed: Obj | null = null;
  for (const [typeId, ords] of Object.entries(directions)) {
    if (Array.isArray(ords) && ords.every(isOrd)) continue;
    fixed = fixed ?? { ...directions };
    const kept = Array.isArray(ords) ? ords.filter(isOrd) : [];
    if (kept.length > 0) {
      fixed[typeId] = kept;
      repaired.push(`${label}: directions of "${typeId}" ${show(ords)} → ${show(kept)}`);
    } else {
      delete fixed[typeId];
      repaired.push(`${label}: directions of "${typeId}" ${show(ords)} removed (every direction of this card type is on)`);
    }
  }
  return fixed ? { ...options, directions: fixed } : options;
}

/* ------------------------------------------------------------------ cards */

/**
 * For the cards whose direction (`ord`) is not a whole number ≥ 0: a function
 * that gives each one the lowest direction that NO card of its note uses. The
 * valid directions of the WHOLE list are counted first, so a later valid
 * card can never collide with a repaired one. Each call takes the direction
 * it gives, so two repaired cards of one note get two directions.
 *
 *   cards of note n1 with ords 0, 2 and 'x' → freeOrd('n1') = 1 (and next time 3)
 */
function freeOrds(cardsIn: readonly unknown[]): (noteId: string) => number {
  const used = new Map<string, Set<number>>();
  const usedOf = (noteId: string) => {
    let set = used.get(noteId);
    if (!set) used.set(noteId, (set = new Set<number>()));
    return set;
  };
  for (const c of cardsIn) {
    if (isObj(c) && isString(c.noteId) && isOrd(c.ord)) usedOf(c.noteId).add(c.ord);
  }
  return (noteId) => {
    const set = usedOf(noteId);
    let ord = 0;
    while (set.has(ord)) ord += 1;
    set.add(ord);
    return ord;
  };
}

/* ------------------------------------------------------------ checkIntegrity */

/**
 * Check and repair the links of a v3 state. See the file comment for every
 * repair. Never throws on a state-shaped object: a list that is not a list
 * is read as empty (and listed), an entry that is not an object (a card
 * type, template, note, card or deck) is removed (and listed), and a card
 * type with a usable id is repaired, never removed (repairTypeShape).
 */
export function checkIntegrity(state: DataStateV3, now: number): IntegrityResult {
  const repaired: string[] = [];
  const raw = state as unknown as Obj;
  const listOf = (key: string): unknown[] => {
    const v = raw[key];
    if (Array.isArray(v)) return v;
    if (v !== undefined) repaired.push(`${key}: ${show(v)} is not a list, read as empty`);
    return [];
  };
  const typesIn = listOf('noteTypes');
  const notesIn = listOf('notes');
  const cardsIn = listOf('cards');
  const decksIn = listOf('decks');

  /* 1. Card types: the first of each id, repaired (never removed for one bad
   *    value), with templates renderFace can read. Only an entry that is not
   *    an object, or has no usable id, is removed: no note can point at it. */
  const types: NoteType[] = [];
  const typeById = new Map<string, NoteType>();
  const valueCountOf = valueCounts(notesIn);
  typesIn.forEach((t, i) => {
    if (!isObj(t)) {
      repaired.push(`card type #${i}: ${show(t)} is not a card type, removed`);
    } else if (!isId(t.id)) {
      repaired.push(`card type #${i}: no usable id (${show(t.id)}), removed (its items get a card type again below)`);
    } else if (typeById.has(t.id)) {
      repaired.push(`card type "${t.id}": a second type with this id, removed`);
    } else {
      const shaped = repairTypeShape(t as Obj & { id: string }, valueCountOf.get(t.id) ?? 0, now, repaired);
      const type = repairTemplates(shaped, repaired);
      types.push(type);
      typeById.set(type.id, type);
    }
  });

  /* 2. Notes: the shape, and one note per id. */
  const notes: Note[] = [];
  const noteIdFor = uniqueIds(idsOf(notesIn));
  // For a note id used by several notes: the new ids of the later copies, in
  // list order ('n1' → ['n1~2', 'n1~3']). Step 3 gives them cards.
  const copiesOf = new Map<string, string[]>();
  notesIn.forEach((n, i) => {
    if (!isObj(n)) {
      repaired.push(`note #${i}: ${show(n)} is not a note, removed`);
      return;
    }
    const own = isId(n.id) ? n.id : `n-repaired-${i}`;
    const id = noteIdFor(own);
    if (id !== own && isId(n.id)) copiesOf.set(own, [...(copiesOf.get(own) ?? []), id]);
    notes.push(repairNoteShape(n, id, repaired));
  });
  const noteIndexById = new Map(notes.map((note, i) => [note.id, i]));

  /* 3. Cards: rule 1 (no note → set aside), a usable direction, rule 6 (one card per note and direction), unique ids. */
  const cards: Card[] = [];
  const cardIdFor = uniqueIds(idsOf(cardsIn));
  const slots = new Set<string>();
  const slotOf = (noteId: string, ord: unknown) => `${noteId}\u0000${String(ord)}`;
  const freeOrd = freeOrds(cardsIn);
  cardsIn.forEach((raw, i) => {
    if (!isObj(raw)) {
      repaired.push(`card #${i}: ${show(raw)} is not a card, removed`);
      return;
    }
    const label = isId(raw.id) ? `card "${raw.id}"` : `card #${i}`;
    if (!isString(raw.noteId) || !noteIndexById.has(raw.noteId)) {
      repaired.push(`${label}: its note ${show(raw.noteId)} is missing, set aside`);
      return;
    }
    // A direction that is not a whole number ≥ 0 (null, 1.5, 'x') → a free one.
    let c: Obj = raw;
    if (!isOrd(raw.ord)) {
      const ord = freeOrd(raw.noteId);
      repaired.push(`${label}: ord ${show(raw.ord)} → ${ord} (the lowest direction its item does not use)`);
      c = { ...raw, ord };
    }
    let noteId = raw.noteId;
    if (slots.has(slotOf(noteId, c.ord))) {
      // The direction is taken. If other notes had this id too, the card
      // belongs to the next copy that does not have this direction yet.
      const free = (copiesOf.get(noteId) ?? []).find((copy) => !slots.has(slotOf(copy, c.ord)));
      if (free === undefined) {
        repaired.push(`${label}: a second card for direction ${show(c.ord)} of note "${noteId}", removed`);
        return;
      }
      repaired.push(
        `${label}: noteId "${noteId}" → "${free}" (note "${noteId}" already has a card for direction ${show(c.ord)}; "${free}" is the next note that had the id "${noteId}")`,
      );
      noteId = free;
    }
    slots.add(slotOf(noteId, c.ord));
    const own = isId(c.id) ? c.id : `card-repaired-${i}`;
    const id = cardIdFor(own);
    if (id !== c.id) repaired.push(`${label}: id ${show(c.id)} → "${id}"`);
    cards.push((id === c.id && noteId === c.noteId ? c : { ...c, id, noteId }) as unknown as Card);
  });

  /* 4. Rule 5: card types that notes point at but that do not exist. */
  const missing = new Map<string, { fieldCount: number; notes: number; ords: number[] }>();
  for (const note of notes) {
    if (typeById.has(note.typeId)) continue;
    const info = missing.get(note.typeId) ?? { fieldCount: 0, notes: 0, ords: [] };
    info.fieldCount = Math.max(info.fieldCount, note.fields.length);
    info.notes += 1;
    missing.set(note.typeId, info);
  }
  if (missing.size > 0) {
    for (const card of cards) {
      const typeId = notes[noteIndexById.get(card.noteId)!].typeId;
      const info = missing.get(typeId);
      if (info && isOrd(card.ord)) info.ords.push(card.ord);
    }
    for (const [typeId, info] of missing) {
      const kind = builtinKindOf(typeId);
      const type = kind ? builtinType(kind, now) : recoveredType(typeId, info.fieldCount, info.ords, now);
      repaired.push(
        kind
          ? `card type "${typeId}": missing, the built-in "${type.name}" was added again`
          : `card type "${typeId}": missing, a "${RECOVERED_TYPE_NAME}" card type with ${plural(type.fields.length, 'field')} was made for ${plural(info.notes, 'item')}`,
      );
      types.push(type);
      typeById.set(typeId, type);
    }
  }

  /* 5. Rule 7: every note has exactly one value per field of its type. */
  const noteIndexesByType = new Map<string, number[]>();
  notes.forEach((note, i) => {
    const group = noteIndexesByType.get(note.typeId);
    if (group) group.push(i);
    else noteIndexesByType.set(note.typeId, [i]);
  });
  for (const [typeId, indexes] of noteIndexesByType) {
    const type = typeById.get(typeId)!;
    const aligned = alignFields(type, indexes, notes, now, repaired);
    if (aligned !== type) {
      types[types.indexOf(type)] = aligned;
      typeById.set(typeId, aligned);
    }
  }

  /* 6. A card type with no template (none was stored, or step 1 removed every
   *    damaged one) gets one "Card <n>" template per direction its cards use,
   *    so every card has a question again and a new item gets cards (addNote
   *    makes one card per template). A built-in type gets its own built-in
   *    templates back instead (so "Basic + reverse" asks the Back field in
   *    direction 2), when it still has every built-in field. It runs after
   *    rule 7, so a "Recovered" field added there is a field of the template too. */
  for (const type of types.filter((t) => t.templates.length === 0)) {
    const builtin = builtinFor(type.id, now);
    let templates: TemplateDef[];
    if (builtin && type.fields.length >= builtin.fields.length) {
      templates = builtin.templates;
      repaired.push(`card type "${type.id}": no usable template, the built-in templates were added again`);
    } else {
      // A cloze card type has ONE template for all its cards (renderFace reads templates[0]).
      const ords =
        type.kind === 'cloze'
          ? []
          : cards.filter((c) => notes[noteIndexById.get(c.noteId)!].typeId === type.id).map((c) => c.ord);
      templates = recoveredTemplates(type.fields.length, type.sortField, ords);
      repaired.push(
        `card type "${type.id}": no usable template, ${plural(templates.length, 'template')} made for the directions its cards use`,
      );
    }
    const filled = { ...type, templates };
    types[types.indexOf(type)] = filled;
    typeById.set(type.id, filled);
  }

  /* 7. Decks: objects only, one deck per id, options the scheduler can read.
   *    Cards point at a deck by id, so they stay in the FIRST deck with that
   *    id; a second deck with the id is kept (its name and settings) under a
   *    new id, with no cards. */
  const decks: Deck[] = [];
  const deckIdFor = uniqueIds(idsOf(decksIn));
  decksIn.forEach((d, i) => {
    if (!isObj(d)) {
      repaired.push(`deck #${i}: ${show(d)} is not a deck, removed`);
      return;
    }
    const id = deckIdFor(isId(d.id) ? d.id : `deck-repaired-${i}`);
    if (id !== d.id) {
      repaired.push(
        isId(d.id)
          ? `deck "${d.id}": a second deck with this id, its id → "${id}" (the cards stay in the first deck)`
          : `deck #${i}: id ${show(d.id)} → "${id}"`,
      );
    }
    const options = repairDeckOptions(d.options, `deck "${id}"`, repaired);
    decks.push((id === d.id && options === d.options ? d : { ...d, id, options }) as unknown as Deck);
  });
  const deckIds = new Set(decks.map((d) => d.id));

  /* 8. Rules 3 and 4: every card in a deck that exists, all cards of a note in one deck. */
  const cardIndexesByNote = new Map<string, number[]>();
  cards.forEach((card, i) => {
    const group = cardIndexesByNote.get(card.noteId);
    if (group) group.push(i);
    else cardIndexesByNote.set(card.noteId, [i]);
  });
  let needsUnfiled = false;
  for (const indexes of cardIndexesByNote.values()) {
    // The home deck: the deck of the lowest-ord card whose deck exists (first one on a tie).
    let home: string | null = null;
    let homeOrd = Infinity;
    for (const i of indexes) {
      const card = cards[i];
      const ord = isOrd(card.ord) ? card.ord : Infinity;
      if (deckIds.has(card.deckId) && (home === null || ord < homeOrd)) {
        home = card.deckId;
        homeOrd = ord;
      }
    }
    const target = home ?? UNFILED_DECK_ID;
    if (target === UNFILED_DECK_ID && !deckIds.has(UNFILED_DECK_ID)) needsUnfiled = true;
    for (const i of indexes) {
      const card = cards[i];
      if (card.deckId === target) continue;
      const why = deckIds.has(card.deckId)
        ? 'all cards of one item stay in one deck'
        : target === UNFILED_DECK_ID
          ? 'its deck is missing'
          : 'its deck is missing; it joins the other cards of its item';
      repaired.push(`card "${card.id}": deckId ${show(card.deckId)} → "${target}" (${why})`);
      cards[i] = { ...card, deckId: target };
    }
  }
  const decksOut = needsUnfiled ? [...decks, unfiledDeck(now, decks)] : decks;
  if (needsUnfiled) repaired.push(`deck "${UNFILED_DECK_ID}": created for cards whose deck was missing`);

  /* 9. The result: unchanged lists (and an intact state) keep their identity. */
  const same = (key: string, next: readonly unknown[]) => Array.isArray(raw[key]) && sameItems(raw[key] as unknown[], next);
  const unchanged =
    same('noteTypes', types) && same('notes', notes) && same('cards', cards) && same('decks', decksOut);
  if (unchanged) return { state, repaired };
  return {
    state: {
      ...state,
      noteTypes: same('noteTypes', types) ? state.noteTypes : types,
      notes: same('notes', notes) ? state.notes : notes,
      cards: same('cards', cards) ? state.cards : cards,
      decks: same('decks', decksOut) ? state.decks : decksOut,
    },
    repaired,
  };
}
