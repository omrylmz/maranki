/**
 * The .apkg reader (spec §5.1, §5.2, unit W2-5): file bytes → AnkiCollection,
 * LOSSLESS. It keeps everything the import needs later: every field, the note
 * `guid`, the templates, the subdeck of every card, the study progress of
 * every card (a card in a filtered deck gets its home-deck due, `homeDue`),
 * the original new-card position of a studied card (`cards.data`, H2),
 * `col.crt` and the media manifest.
 *
 * An .apkg is a ZIP file. Inside:
 *   - a SQLite database with the collection: `collection.anki21` (Anki's
 *     "support older versions" export) or `collection.anki2` (older Anki,
 *     genanki, AnkiWeb). Modern Anki's default export `collection.anki21b`
 *     is Zstd-compressed with a newer schema and is NOT supported (§7 row 62);
 *   - `media`: a JSON manifest, "0" → "example.webp";
 *   - the media files themselves, stored under the numbers "0", "1" …
 *
 * Two halves, so most of it can be tested without a phone:
 *   - `readApkg(bytes, fileName)` — the thin I/O: unzip (fflate), open the
 *     database in memory (expo-sqlite `deserializeDatabaseAsync`), run three
 *     queries (the cards query once more without `data` when the table has
 *     no such column), close.
 *   - `collectionFromRows(rows)` — PURE: turns the raw rows into an
 *     AnkiCollection. Tested on the real deck fixtures.
 *
 * File precedence is unchanged from importApkg.ts (the modern-Anki
 * "dummy collection" fix): `collection.anki21` first; else
 * `collection.anki21b` → an honest "newer format" error; else
 * `collection.anki2`. Modern Anki always adds a dummy `collection.anki2`
 * (one "please update Anki" note) next to the real data, so `anki2` must be
 * the LAST choice.
 *
 * Images are NOT unpacked here. `mediaBytes(name)` unpacks one image when the
 * import writes it, and `mediaSize(name)` reads its size from the zip
 * directory. So a deck with 180 MB of images costs no memory until the user
 * says yes. (The archive bytes stay in memory while the collection is in use.)
 *
 * Untrusted keys (H2). Model ids, deck ids and manifest keys come from the
 * file. A key such as "__proto__" would change the PROTOTYPE of a plain `{}`
 * when it is assigned (`out['__proto__'] = x`), and "constructor" would find
 * Object's built-in function when it is read. So `models`, `decks` and
 * `media` are built with `Object.create(null)`: an object with no prototype,
 * where every key is only a key.
 */
import { deserializeDatabaseAsync } from 'expo-sqlite';
import { strFromU8, unzipSync } from 'fflate';

import { FIELD_SEP } from '../anki';
import { ApkgError } from '../importApkg';
import type { AnkiCollection } from '../model';
import { isImageName } from './mediaPlan';

/* --------------------------------------------------------------- raw rows */

/** An id as SQLite or a JSON fixture gives it: text (with `cast(… as text)`) or a number. */
export type RawId = string | number | bigint | null | undefined;
/** A number column as SQLite gives it (a text value is converted). */
export type RawNum = number | string | null | undefined;

/** The raw rows of one collection, as the three queries (or a fixture file) return them. */
export interface ApkgRows {
  fileName: string;
  /** The single `col` row. `models` and `decks` are Anki's raw JSON text. */
  col: { crt: RawNum; models: string | null; decks: string | null };
  /** `notes` rows. `flds` is joined by '\x1f'; `tags` is space-separated. */
  notes: { id: RawId; guid: string | null; mid: RawId; flds: string | null; tags: string | null }[];
  /** `cards` rows. */
  cards: {
    id: RawId;
    nid: RawId;
    did: RawId;
    odid: RawId;
    ord: RawNum;
    type: RawNum;
    queue: RawNum;
    due: RawNum;
    /** The real due of a card that sits in a filtered deck (see `homeDue`). Optional: older row sources lack it. */
    odue?: RawNum;
    ivl: RawNum;
    factor: RawNum;
    reps: RawNum;
    lapses: RawNum;
    flags: RawNum;
    /**
     * Anki's `cards.data` JSON text, e.g. '{"pos":12}' (see `originalPosition`).
     * Optional: older row sources, and a cards table without the column, lack it.
     */
    data?: string | null;
  }[];
  /** The media manifest: the parsed object, or the raw JSON text of the `media` zip entry. */
  media: Record<string, unknown> | string | null;
}

/** Text of an id. Anki ids are 64-bit; the SQL reads them as text so no digit is lost. */
function idText(v: RawId): string {
  if (v === null || v === undefined) return '';
  return typeof v === 'string' ? v.trim() : String(v);
}

/** A number column. Missing → NaN (the progress mapping turns NaN into "New"). */
function num(v: RawNum): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return NaN;
}

/** A small whole number (ord, sortf): not finite or negative → `fallback`. */
function smallInt(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : fallback;
}

/** JSON.parse that returns an empty object for bad input instead of throwing. */
function parseObject(json: string | null | undefined): Record<string, unknown> {
  if (!json) return {};
  try {
    const v: unknown = JSON.parse(json);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const byOrd = <T extends { ord: number }>(a: T, b: T) => a.ord - b.ord;

/** An empty record with NO prototype: a key from the file ("__proto__", "constructor") is only a key here. */
function emptyRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/**
 * The original new-card position of a card, from Anki's `cards.data` JSON.
 * Anki 2.1.55+ writes `{"pos": 12}` when a NEW card is studied for the first
 * time (so "Reset" can put it back in its place); after that, `due` is a date
 * and no longer the position. Anything that is not a whole number ≥ 0 (no
 * data, bad JSON, older Anki, genanki's '') → undefined. Like Anki, a bad
 * value is ignored, never an error.
 *
 *   originalPosition('{"pos":12,"s":3.1}') → 12
 *   originalPosition('')                    → undefined
 *   originalPosition('{"pos":"x"}')         → undefined
 */
export function originalPosition(data: string | null | undefined): number | undefined {
  if (!data || data.indexOf('pos') < 0) return undefined;
  const pos = parseObject(data).pos;
  return typeof pos === 'number' && Number.isInteger(pos) && pos >= 0 ? pos : undefined;
}

/** `col.models` JSON → the models of AnkiCollection (fields and templates sorted by ord). */
function parseModels(json: string | null): AnkiCollection['models'] {
  const raw = parseObject(json);
  const out = emptyRecord<AnkiCollection['models'][string]>();
  for (const mid of Object.keys(raw)) {
    const m = raw[mid] as Record<string, unknown> | null;
    if (!m || typeof m !== 'object') continue;
    const flds = Array.isArray(m.flds) ? (m.flds as Record<string, unknown>[]) : [];
    const tmpls = Array.isArray(m.tmpls) ? (m.tmpls as Record<string, unknown>[]) : [];
    out[mid] = {
      name: str(m.name),
      type: m.type === 1 ? 1 : 0,
      sortf: smallInt(m.sortf, 0),
      flds: flds
        .map((f, i) => ({ name: str(f?.name), ord: smallInt(f?.ord, i) }))
        .sort(byOrd),
      tmpls: tmpls
        .map((t, i) => ({ name: str(t?.name), ord: smallInt(t?.ord, i), qfmt: str(t?.qfmt), afmt: str(t?.afmt) }))
        .sort(byOrd),
    };
  }
  return out;
}

/** `col.decks` JSON → did → full name ("German::Verbs::B1"). */
function parseDecks(json: string | null): Record<string, string> {
  const raw = parseObject(json);
  const out = emptyRecord<string>();
  for (const did of Object.keys(raw)) {
    const name = (raw[did] as { name?: unknown } | null)?.name;
    if (typeof name === 'string') out[did] = name;
  }
  return out;
}

/** The media manifest, with only string values kept. */
function parseManifest(media: ApkgRows['media']): Record<string, string> {
  const raw = typeof media === 'string' ? parseObject(media) : (media ?? {});
  const out = emptyRecord<string>();
  for (const key of Object.keys(raw)) {
    const name = raw[key];
    if (typeof name === 'string' && name) out[key] = name;
  }
  return out;
}

/** Anki's space-separated tag string → tags (empty parts dropped). */
function splitTags(tags: string | null): string[] {
  if (!tags) return [];
  return tags.split(/\s+/).filter((t) => t.length > 0);
}

/**
 * The due of a card in its HOME deck.
 *
 * When Anki moves a card into a filtered deck (for example an old "Custom
 * Study Session"), it saves the real due in `odue` and writes the card's
 * place in the filtered deck into `due` (-100000 + n). Read as a day number,
 * -99997 is a date around the year 1750, and as a new-card position it would
 * come before every other card. So, like Anki's own importer: a card with
 * `odid` set and a non-zero `odue` gets `odue` as its due. (Anki sets `odue`
 * back to 0 when the card is answered inside the filtered deck; then `due` is
 * already the real one.)
 *
 *   homeDue('0', -99997, 20000)          → -99997  (not in a filtered deck)
 *   homeDue('1700000003', -99997, 20000) → 20000
 *   homeDue('1700000003', 812, 0)        → 812     (answered in the filtered deck)
 */
export function homeDue(odid: string, due: number, odue: number): number {
  return odid !== '0' && Number.isFinite(odue) && odue !== 0 ? odue : due;
}

/**
 * The raw rows of a collection → AnkiCollection. Pure and lossless: every
 * note, card, model, template and deck is kept, in the order given (the
 * query sorts notes by id, cards by note then ord). Bad JSON gives empty
 * maps instead of an error; bad numbers stay NaN for the progress mapping.
 * A card in a filtered deck gets the due of its home deck (`homeDue`), and a
 * studied card keeps its original new-card position (`originalPosition`).
 * `models`, `decks` and `media` have no prototype (see the top of the file).
 */
export function collectionFromRows(rows: ApkgRows): AnkiCollection {
  const crt = num(rows.col.crt);
  return {
    fileName: rows.fileName,
    crt: Number.isFinite(crt) ? crt : 0,
    models: parseModels(rows.col.models),
    decks: parseDecks(rows.col.decks),
    notes: rows.notes.map((n) => ({
      id: idText(n.id),
      guid: (n.guid ?? '').trim(),
      mid: idText(n.mid),
      flds: (n.flds ?? '').split(FIELD_SEP),
      tags: splitTags(n.tags),
    })),
    cards: rows.cards.map((c) => {
      const rawOdid = idText(c.odid);
      const odid = rawOdid === '' ? '0' : rawOdid;
      const rawOdue = num(c.odue);
      const odue = Number.isFinite(rawOdue) ? rawOdue : 0;
      const originalPos = originalPosition(c.data);
      return {
        id: idText(c.id),
        nid: idText(c.nid),
        did: idText(c.did),
        odid,
        ord: smallInt(num(c.ord), 0),
        type: num(c.type),
        queue: num(c.queue),
        due: homeDue(odid, num(c.due), odue),
        odue,
        ivl: num(c.ivl),
        factor: num(c.factor),
        reps: num(c.reps),
        lapses: num(c.lapses),
        flags: num(c.flags),
        ...(originalPos !== undefined ? { originalPos } : {}),
      };
    }),
    media: parseManifest(rows.media),
  };
}

/* ------------------------------------------------------- collection choice */

const ANKI21 = 'collection.anki21';
const ANKI21B = 'collection.anki21b';
const ANKI2 = 'collection.anki2';

/**
 * Which collection file of the archive to read (precedence above). Throws
 * ApkgError 'newer-format' when only `collection.anki21b` holds the data,
 * 'no-collection' when there is no collection at all.
 */
export function pickCollectionFile(names: Iterable<string>): typeof ANKI21 | typeof ANKI2 {
  const set = new Set(names);
  if (set.has(ANKI21)) return ANKI21; // Legacy 2 export: real schema-11 data.
  if (set.has(ANKI21B)) throw new ApkgError('newer-format', 'Zstd collection.'); // V3: schema 18.
  if (set.has(ANKI2)) return ANKI2; // Legacy 1 (genanki / AnkiWeb): the only collection.
  throw new ApkgError('no-collection', 'No collection in archive.');
}

/* --------------------------------------------------------------------- I/O */

interface ColRow {
  crt: RawNum;
  models: string | null;
  decks: string | null;
}

/**
 * Read an .apkg file into an AnkiCollection. Throws ApkgError
 * ('corrupt' | 'newer-format' | 'no-collection' | 'empty') — importApkg.ts's
 * `apkgErrorMessage(err)` gives the user-facing text.
 */
export async function readApkg(bytes: Uint8Array, fileName: string): Promise<AnkiCollection> {
  // 1. List the archive (names + uncompressed sizes) without unpacking anything.
  const sizes = new Map<string, number>();
  try {
    unzipSync(bytes, {
      filter: (f) => {
        sizes.set(f.name, f.originalSize);
        return false;
      },
    });
  } catch {
    throw new ApkgError('corrupt', 'Not a valid .apkg archive.');
  }
  const collectionFile = pickCollectionFile(sizes.keys());

  // 2. Unpack only the chosen collection and the media manifest.
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, { filter: (f) => f.name === collectionFile || f.name === 'media' });
  } catch {
    throw new ApkgError('corrupt', 'Not a valid .apkg archive.');
  }
  const dbBytes = entries[collectionFile];
  if (!dbBytes) throw new ApkgError('no-collection', 'No collection in archive.');
  let manifestText: string | null = null;
  try {
    manifestText = entries.media ? strFromU8(entries.media) : null;
  } catch {
    manifestText = null; // an unreadable manifest only costs the images
  }

  // 3. Open the database in memory (no temp file) and read the three tables.
  let db;
  try {
    db = await deserializeDatabaseAsync(dbBytes);
  } catch {
    throw new ApkgError('corrupt', 'Collection is not a readable SQLite database.');
  }
  let rows: ApkgRows;
  try {
    let col: ColRow | null;
    try {
      col = await db.getFirstAsync<ColRow>('SELECT crt, models, decks FROM col LIMIT 1');
    } catch {
      // A schema-18 collection has no `models` column.
      throw new ApkgError('newer-format', 'col.models missing (v18 schema).');
    }
    try {
      // cast(… as text): Anki ids are 64-bit; text keeps every digit.
      const notes = await db.getAllAsync<ApkgRows['notes'][number]>(
        'SELECT cast(id as text) AS id, guid, cast(mid as text) AS mid, flds, tags FROM notes ORDER BY id',
      );
      const cardColumns =
        'cast(id as text) AS id, cast(nid as text) AS nid, cast(did as text) AS did, ' +
        'cast(odid as text) AS odid, ord, type, queue, due, odue, ivl, factor, reps, lapses, flags';
      let cards: ApkgRows['cards'];
      try {
        // `data` holds the original new-card position of a studied card (`originalPosition`).
        cards = await db.getAllAsync<ApkgRows['cards'][number]>(
          `SELECT ${cardColumns}, data FROM cards ORDER BY nid, ord`,
        );
      } catch {
        // Every Anki schema-11 cards table has `data`, but a file from another
        // tool may not. Without it only the original positions are lost, so
        // read the table again without that column instead of refusing the file.
        cards = await db.getAllAsync<ApkgRows['cards'][number]>(`SELECT ${cardColumns} FROM cards ORDER BY nid, ord`);
      }
      rows = {
        fileName,
        col: { crt: col?.crt ?? null, models: col?.models ?? null, decks: col?.decks ?? null },
        notes,
        cards,
        media: manifestText,
      };
    } catch {
      throw new ApkgError('corrupt', 'Could not read the notes or cards table.');
    }
  } finally {
    try {
      await db.closeAsync();
    } catch {
      // Closing an in-memory database cannot lose data; ignore.
    }
  }

  const collection = collectionFromRows(rows);
  if (collection.notes.length === 0) throw new ApkgError('empty', 'No notes in the collection.');

  // 4. Lazy media access by file name ("example.webp" → zip entry "0").
  const entryOf = new Map<string, string>();
  for (const key of Object.keys(collection.media)) entryOf.set(collection.media[key], key);
  collection.mediaSize = (name) => {
    const key = entryOf.get(name);
    return key === undefined ? null : (sizes.get(key) ?? null);
  };
  collection.mediaBytes = (name) => {
    const key = entryOf.get(name);
    if (key === undefined || !sizes.has(key) || !isImageName(name)) return null;
    try {
      // fflate returns a plain `{}` keyed by entry name. For the entry name
      // "__proto__" the bytes become its PROTOTYPE (so `[key]` still finds
      // them), and when nothing was unpacked `[key]` would be Object.prototype.
      // So only real bytes are returned.
      const found: unknown = unzipSync(bytes, { filter: (f) => f.name === key })[key];
      return found instanceof Uint8Array ? found : null;
    } catch {
      return null;
    }
  };
  return collection;
}
