/**
 * Import wizard — a CSV read again keeps the learner's column choices
 * (unit A5, W3-5 hardening; spec §5.7, §5.9). Pure: no React, no clock.
 *
 * The Fields stage reads a CSV file again when the learner taps "Tags" on a
 * column, "Not tags", or "First row is a header" (import.tsx `rereadCsv`).
 * The new read gives a FRESH guess (roles.ts `suggestMapping`). Without this
 * module every choice the learner made (Front, Back, Ignore, a label, a
 * read-aloud language, "Also make a reverse card") would be thrown away.
 *
 * A field is matched by its SOURCE, not by its name. The source is the file
 * column the field is read from, plus the header cell of that column (null
 * when the file has no header row). WHY not the name: a CSV without a header
 * names its fields by POSITION among the field columns ("Field 1", "Field 2"
 * …, csvRead.ts). When a middle column becomes the tags column, every later
 * field gets a new name, so a match by name gave a choice to the wrong column
 * (review round 1):
 *
 *   Haus,house,A1,noun,home   (no header)
 *   before:  col 0 "Field 1" · col 1 "Field 2" = Front · col 2 "Field 3" · col 3 "Field 4" = Ignore
 *   "Tags" on col 2 → fresh: col 0 "Field 1" · col 1 "Field 2" · col 3 "Field 3" · col 4 "Field 4"
 *   carried: col 1 is still the Front, col 3 is still Ignore,
 *            col 4 is new to the Fields stage: the fresh guess.
 *
 * The header cell is part of the source, so "First row is a header" (every
 * header cell changes: null ↔ a name) starts every field again from the
 * fresh guess. The directions stay: they are a choice of the card type, not
 * of a field.
 */
import type { TypeStart } from '@/domain/import/plan';
import { csvFieldColumns, facetForRole } from '@/domain/importFile';
import type { AnkiCollection, FieldDef, FieldRole } from '@/domain/model';

/** Where a field of a CSV is read from. */
export interface CsvFieldSource {
  /** The file column (0-based). */
  column: number;
  /** The header cell of that column, or null when the file has no header row. */
  head: string | null;
}

/**
 * The source of every field of a CSV collection (field k → its file column
 * and header cell). Not a CSV → [].
 *
 *   header "Word,Tags,Meaning", tags column 1 →
 *     [{ column: 0, head: 'Word' }, { column: 2, head: 'Meaning' }]
 */
export function csvFieldSources(collection: AnkiCollection, fieldCount: number): CsvFieldSource[] {
  const header = collection.csv?.header ?? null;
  return csvFieldColumns(collection, fieldCount).map((column) => ({
    column,
    head: header === null ? null : (header[column] ?? ''),
  }));
}

/** The parts of a Fields-stage edit that this module reads and writes. */
type Choices = Pick<TypeStart, 'mid' | 'fields' | 'ords'>;

/** One read of the file: the collection, and the edits (or fresh starts) of its card types. */
export interface CsvRead<T extends Choices> {
  collection: AnkiCollection;
  types: readonly T[];
}

/**
 * The fresh starts of a CSV read again, with the learner's earlier choices
 * carried over (same order as `fresh.types`, so `draft.types[k]` still fits):
 *   - a field read from the SAME column under the SAME header cell as before
 *     keeps its choice: role, label, read-aloud language, filter setting. Its
 *     name is the fresh one (the card type's field name);
 *   - `multiSep` (several values in one cell) is a fact about the column's
 *     values, not a choice: it stays only on a filter, from the fresh read of
 *     that column (else the old read of the same column);
 *   - a field that is new (a column that was the tags column, or the first
 *     time a column is a field) starts from the fresh guess;
 *   - the directions ("Also make a reverse card") stay.
 * Front and Back stay ONE field each:
 *   - a kept field and a new field are both the Front (or the Back): the kept
 *     one stays it, the new one becomes a back row;
 *   - the column that was the Front (or the Back) became the tags column: the
 *     Front AND the Back both start again from the fresh guess (every other
 *     choice still stays).
 * A card type that was not there before is the fresh guess as it is.
 */
export function carryFieldChoices<T extends Choices>(before: CsvRead<Choices>, fresh: CsvRead<T>): T[] {
  return fresh.types.map((next) => {
    const old = before.types.find((b) => b.mid === next.mid);
    if (!old) return next;
    const oldSources = csvFieldSources(before.collection, old.fields.length);
    const newSources = csvFieldSources(fresh.collection, next.fields.length);
    // For each fresh field: the index of the old field with the same source (-1: a new field).
    const from = next.fields.map((_, i) => {
      const source = newSources[i];
      if (!source) return -1;
      return oldSources.findIndex((o) => o.column === source.column && o.head === source.head);
    });
    const kept = from.map((j) => j >= 0);
    let fields = next.fields.map((f, i) => (from[i] >= 0 ? carryChoice(old.fields[from[i]], f) : { ...f }));
    fields = keepOneHeadline(fields, kept, 'term');
    fields = keepOneHeadline(fields, kept, 'meaning');
    // A headline the guess has is missing now: Front and Back come from the guess.
    const guessTerm = next.fields.findIndex((f) => f.role === 'term');
    const guessMeaning = next.fields.findIndex((f) => f.role === 'meaning');
    const lost = (role: FieldRole, guessed: number) => guessed >= 0 && !fields.some((f) => f.role === role);
    if (lost('term', guessTerm) || lost('meaning', guessMeaning)) {
      fields = fields.map((f, i) => {
        if (i === guessTerm) return withRole(f, 'term');
        if (i === guessMeaning) return withRole(f, 'meaning');
        return f.role === 'term' || f.role === 'meaning' ? withRole(f, 'detail') : f;
      });
    }
    return { ...next, fields, ords: old.ords.length > 0 ? [...old.ords] : [...next.ords] };
  });
}

/**
 * The learner's choice of one column, on the fresh field of the same column.
 * Only the choices are copied (role, label, lang, facet); the name is the
 * fresh one. `multiSep` comes from the data (the fresh read first).
 */
function carryChoice(old: FieldDef, fresh: FieldDef): FieldDef {
  const out: FieldDef = { name: fresh.name, role: old.role, facet: old.facet };
  if (old.label !== undefined) out.label = old.label;
  if (old.lang !== undefined) out.lang = old.lang;
  if (old.role === 'badge') {
    const sep = fresh.multiSep ?? old.multiSep;
    if (sep) out.multiSep = sep;
  }
  return out;
}

/**
 * A field with a new role and that role's default filter setting; `multiSep`
 * only stays on a badge (the same rule as importFile.ts's role edits).
 */
function withRole(f: FieldDef, role: FieldRole): FieldDef {
  const out: FieldDef = { ...f, role, facet: facetForRole(role) };
  if (role !== 'badge') delete out.multiSep;
  return out;
}

/**
 * At most one field has `role` (the Front 'term' or the Back 'meaning').
 * When several have it, the first KEPT one keeps it (else the first one), and
 * the others become back rows ('detail').
 */
function keepOneHeadline(fields: FieldDef[], kept: readonly boolean[], role: 'term' | 'meaning'): FieldDef[] {
  const holders = fields.map((f, i) => (f.role === role ? i : -1)).filter((i) => i >= 0);
  if (holders.length <= 1) return fields;
  const winner = holders.find((i) => kept[i]) ?? holders[0];
  return fields.map((f, i) => (f.role === role && i !== winner ? withRole(f, 'detail') : f));
}
