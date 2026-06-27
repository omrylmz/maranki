/**
 * .apkg import I/O — the side-effectful half (the field mapping is pure, in
 * anki.ts). An .apkg is a ZIP wrapping a SQLite collection:
 *   - unzip (fflate) and pull out `collection.anki2` (schema v11, plain SQLite);
 *   - open those bytes directly with expo-sqlite's deserializeDatabaseAsync
 *     (no temp file on disk);
 *   - read the single `col` row (models + decks JSON) and the `notes` table;
 *   - map notes → cards via anki.ts and return { payload, name }, the same
 *     shape the CSV path produces, so import.tsx feeds it into the existing
 *     preview → import → study flow unchanged.
 *
 * Only the legacy `collection.anki2` (v11) format is supported. Modern Anki's
 * Zstd-compressed `collection.anki21b` / v18 schema throws ApkgError so the UI
 * can tell the user to re-export with "support older Anki versions" on.
 */
import { deserializeDatabaseAsync } from 'expo-sqlite';
import { unzipSync } from 'fflate';

import { AnkiNoteRow, ankiDeckName, buildApkgPayload, parseAnkiModels } from './anki';
import { deckNameFromFile, ParsedImport } from './importFile';
import { ImportCardPayload } from './importSamples';

export type ApkgErrorCode = 'newer-format' | 'no-collection' | 'empty' | 'corrupt';

export class ApkgError extends Error {
  code: ApkgErrorCode;
  constructor(code: ApkgErrorCode, message: string) {
    super(message);
    this.name = 'ApkgError';
    this.code = code;
  }
}

/** User-facing message for each failure mode. */
export function apkgErrorMessage(err: unknown): string {
  const code = err instanceof ApkgError ? err.code : 'corrupt';
  switch (code) {
    case 'newer-format':
      return "This .apkg uses Anki's newer format. In Anki, re-export with “Support older Anki versions” checked, then import that file.";
    case 'no-collection':
      return "That .apkg has no readable collection — it may be a media-only or damaged export.";
    case 'empty':
      return 'No cards found in that .apkg.';
    default:
      return 'Could not read that .apkg. Try re-exporting it from Anki.';
  }
}

interface ColRow {
  models: string | null;
  decks: string | null;
}

/**
 * Parse an .apkg's raw bytes into importable cards. Throws ApkgError on
 * unsupported/empty/corrupt packages.
 */
export async function parseApkg(bytes: Uint8Array, fileName: string): Promise<ParsedImport> {
  // 1. Unzip — only the collection db, never the (potentially huge) media blobs.
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, {
      filter: (f) =>
        f.name === 'collection.anki2' ||
        f.name === 'collection.anki21' ||
        f.name === 'collection.anki21b',
    });
  } catch {
    throw new ApkgError('corrupt', 'Not a valid .apkg archive.');
  }

  // Select by FILENAME in Anki's own precedence. Modern Anki always bundles a
  // dummy `collection.anki2` (one "please update Anki" note) as a back-compat
  // shim next to the real collection, so it must be the LAST resort — preferring
  // it silently imports the dummy and drops the real deck. Real data lives in
  // `collection.anki21` (Legacy2 export) or the Zstd `collection.anki21b` (V3).
  let dbBytes: Uint8Array | undefined;
  if (entries['collection.anki21']) {
    dbBytes = entries['collection.anki21']; // Legacy2: real schema-11 data
  } else if (entries['collection.anki21b']) {
    throw new ApkgError('newer-format', 'Zstd collection.'); // V3: schema-18, unreadable here
  } else if (entries['collection.anki2']) {
    dbBytes = entries['collection.anki2']; // Legacy1 (genanki / AnkiWeb): only collection present
  } else {
    throw new ApkgError('no-collection', 'No collection in archive.');
  }

  // 2. Open the bytes as an in-memory database (no temp file).
  let db;
  try {
    db = await deserializeDatabaseAsync(dbBytes);
  } catch {
    throw new ApkgError('corrupt', 'Collection is not a readable SQLite database.');
  }

  try {
    // 3. Read models + decks (the col table holds exactly one row). A v18 schema
    //    lacks the `models` column → the query throws → treat as newer-format.
    let col: ColRow | null;
    try {
      col = await db.getFirstAsync<ColRow>('SELECT models, decks FROM col LIMIT 1');
    } catch {
      throw new ApkgError('newer-format', 'col.models missing (v18 schema).');
    }
    const models = parseAnkiModels(col?.models ?? '{}');
    const deckNames = parseDeckNames(col?.decks ?? '{}');

    // 4. Read notes. cast(mid as text) keeps the model id aligned with the
    //    string keys of the models map (and dodges any 53-bit precision worry).
    const rows = await db.getAllAsync<AnkiNoteRow>(
      'SELECT cast(mid as text) as mid, flds, tags FROM notes',
    );

    const payload: ImportCardPayload[] = buildApkgPayload(rows, models);
    if (payload.length === 0) throw new ApkgError('empty', 'No notes with a front field.');

    const name = ankiDeckName(deckNames, deckNameFromFile(fileName));
    return { payload, name };
  } finally {
    try {
      await db.closeAsync();
    } catch {
      // closing a read-only in-memory db can't meaningfully fail; ignore.
    }
  }
}

function parseDeckNames(decksJson: string): string[] {
  try {
    const raw = JSON.parse(decksJson) as Record<string, { name?: string }>;
    return Object.keys(raw)
      .map((k) => raw[k]?.name)
      .filter((n): n is string => typeof n === 'string');
  } catch {
    return [];
  }
}
