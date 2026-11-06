/**
 * Tests for the backup file format (spec §8.4, unit W1-6): the envelope is
 * written and read back; old raw exports and the saved documents of old
 * builds are accepted; broken files are `invalid`; the state always goes
 * through the INJECTED migrate (here a fake one), and its `too-new` answer
 * passes through unchanged. File names (wave 5d, L8): every backup name is
 * made in the phone's LOCAL time (src/store/backup.ts), and a source check
 * keeps new UTC names out.
 */
import { describe, expect, test } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

import type { RevlogRow } from '../domain/model';
import { serialize } from '../store/persistence';
import { buildSeedState } from '../domain/seed';
import { CURRENT_SCHEMA } from '../domain/types';
import { FIXED_NOW } from '../test/clock';
import { makeState, STATE_FIXTURES, stateFixture, stateFixtureRaw } from '../test/factories';
import { localBackupFileName, stampTimeOf } from '../store/backup';
import * as backupFileModule from './backupFile';
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  BackupMedia,
  BackupMeta,
  decodeBackup,
  encodeBackup,
  isSafeFileName,
  makeBackupEnvelope,
  MigrateFn,
  MigrateResult,
} from './backupFile';

const NOW = FIXED_NOW;
const META: BackupMeta = { exportedAt: NOW - 60_000, app: { variant: 'generic', version: '2.2.0' } };

type Doc = Record<string, unknown>;

/**
 * A fake migrate that follows the rules of spec §3.1–§3.2 closely enough for
 * these tests: not a Maranki document → invalid; a newer document that this
 * reader may not read → too-new; else ok, with the version it came from.
 * It records every call, so a test can check what decodeBackup handed over.
 */
function fakeMigrate(answer?: (doc: Doc) => MigrateResult<Doc>) {
  const calls: { doc: unknown; now: number }[] = [];
  const migrate: MigrateFn<Doc> = (doc, now) => {
    calls.push({ doc, now });
    const d = doc as Doc;
    if (answer) return answer(d);
    if (!Array.isArray(d.cards) || !Array.isArray(d.decks)) return { kind: 'invalid' };
    const version = typeof d.schemaVersion === 'number' ? d.schemaVersion : null;
    const minReader = typeof d.minReaderVersion === 'number' ? d.minReaderVersion : null;
    // The real rule (spec §3.1 rule 6) with this build's schema.
    if (version !== null && version > CURRENT_SCHEMA && minReader !== null && minReader > CURRENT_SCHEMA) {
      return { kind: 'too-new', version };
    }
    return { kind: 'ok', state: { ...d, migrated: true }, from: version ?? (isV0(d) ? 0 : 1), repaired: [] };
  };
  return { migrate, calls };
}

/** The v0 detection rule of spec §3.1 (a document without schemaVersion). */
function isV0(d: Doc): boolean {
  const cards = d.cards as Doc[];
  const decks = d.decks as Doc[];
  const settings = (d.settings ?? {}) as Doc;
  return (
    cards.some((c) => typeof c.word === 'string' && typeof c.front !== 'string') ||
    (cards.length === 0 && decks.some((k) => 'flag' in k && !('icon' in k))) ||
    (typeof settings.ttsEnabled === 'boolean' && !('readAloudEnabled' in settings))
  );
}

function revlogRow(overrides: Partial<RevlogRow> = {}): RevlogRow {
  return {
    seq: 1,
    cardId: 'card-1',
    deckId: 'deck-1',
    atMs: NOW - 3_600_000,
    rating: 'good',
    bucket: 'review',
    ivlBefore: 3,
    ivlAfter: 7,
    easeAfter: 2.5,
    durationMs: 4200,
    ...overrides,
  };
}

describe('encodeBackup / makeBackupEnvelope', () => {
  test('wraps the state in the envelope of spec §8.4', () => {
    const state = makeState();
    const envelope = makeBackupEnvelope(state, META);
    expect(envelope).toEqual({
      format: 'maranki-backup',
      version: 1,
      schemaVersion: state.schemaVersion,
      exportedAt: META.exportedAt,
      app: { variant: 'generic', version: '2.2.0' },
      data: state,
    });
    expect(BACKUP_FORMAT).toBe('maranki-backup');
    expect(BACKUP_VERSION).toBe(1);
  });

  test('revlog and media are left out when not given (no undefined keys)', () => {
    const envelope = makeBackupEnvelope(makeState(), META);
    expect(Object.keys(envelope)).not.toContain('revlog');
    expect(Object.keys(envelope)).not.toContain('media');
  });

  test('schemaVersion is copied from the state', () => {
    const envelope = JSON.parse(encodeBackup(makeState({ schemaVersion: 3 }), META)) as Doc;
    expect(envelope.schemaVersion).toBe(3);
  });

  test('encodeBackup is the envelope as JSON', () => {
    const state = makeState();
    const media: BackupMedia[] = [{ deckId: 'deck-1', name: 'map.png', base64: 'iVBORw0KGgo=' }];
    const text = encodeBackup(state, { ...META, revlog: [revlogRow()], media });
    expect(JSON.parse(text)).toEqual(makeBackupEnvelope(state, { ...META, revlog: [revlogRow()], media }));
  });
});

describe('decodeBackup — envelopes', () => {
  test('round trip: encode → decode gives the state, the file facts, revlog and media back', () => {
    const state = makeState();
    const revlog = [revlogRow({ seq: 1 }), revlogRow({ seq: 2, durationMs: null, bucket: 'new', rating: 'again' })];
    const media: BackupMedia[] = [{ deckId: 'deck-1', name: 'map.png', base64: 'iVBORw0KGgo=' }];
    const { migrate, calls } = fakeMigrate();

    const result = decodeBackup(encodeBackup(state, { ...META, revlog, media }), migrate, NOW);

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.state).toEqual({ ...state, migrated: true });
    expect(result.from).toBe(2);
    expect(result.info).toEqual({
      format: 'envelope',
      exportedAt: META.exportedAt,
      app: META.app,
      schemaVersion: 2,
    });
    expect(result.revlog).toEqual(revlog);
    expect(result.media).toEqual(media);
    expect(result.skipped).toEqual({ revlog: 0, media: 0 });
    // Delegation: migrate got the DATA (not the envelope) and the caller's clock, once.
    expect(calls).toHaveLength(1);
    expect(calls[0].doc).toEqual(state);
    expect(calls[0].now).toBe(NOW);
  });

  test('a backup without revlog and media gives empty lists', () => {
    const result = decodeBackup(encodeBackup(makeState(), META), fakeMigrate().migrate, NOW);
    expect(result.kind === 'ok' && result.revlog).toEqual([]);
    expect(result.kind === 'ok' && result.media).toEqual([]);
  });

  test('a UTF-8 BOM at the start of the file is allowed', () => {
    const result = decodeBackup('\uFEFF' + encodeBackup(makeState(), META), fakeMigrate().migrate, NOW);
    expect(result.kind).toBe('ok');
  });

  test('a newer envelope layout → too-new, and migrate is never called', () => {
    const { migrate, calls } = fakeMigrate();
    const newer = { ...makeBackupEnvelope(makeState(), META), version: 2, schemaVersion: 5 };
    expect(decodeBackup(JSON.stringify(newer), migrate, NOW)).toEqual({ kind: 'too-new', version: 5 });
    const noSchema = { format: BACKUP_FORMAT, version: 3, data: {} };
    expect(decodeBackup(JSON.stringify(noSchema), migrate, NOW)).toEqual({ kind: 'too-new', version: 3 });
    expect(calls).toHaveLength(0);
  });

  test('a broken envelope → invalid, and migrate is never called', () => {
    const { migrate, calls } = fakeMigrate();
    const good = makeBackupEnvelope(makeState(), META) as unknown as Doc;
    const broken: Doc[] = [
      { ...good, version: undefined },
      { ...good, version: 0 },
      { ...good, version: '1' },
      { ...good, version: 1.5 },
      { ...good, data: undefined },
      { ...good, data: null },
      { ...good, data: [] },
      { ...good, data: 'state' },
    ];
    for (const doc of broken) {
      expect(decodeBackup(JSON.stringify(doc), migrate, NOW)).toEqual({ kind: 'invalid' });
    }
    expect(calls).toHaveLength(0);
  });

  test('broken file facts become null, the backup still restores', () => {
    const doc = { ...makeBackupEnvelope(makeState(), META), exportedAt: 'yesterday', app: { variant: 1 } };
    const result = decodeBackup(JSON.stringify(doc), fakeMigrate().migrate, NOW);
    expect(result.kind === 'ok' && result.info).toEqual({
      format: 'envelope',
      exportedAt: null,
      app: null,
      schemaVersion: 2,
    });
  });

  test('broken review-history rows are left out and counted; a missing duration becomes null', () => {
    const noDuration: Doc = { ...revlogRow({ seq: 5 }), extra: 'dropped' };
    delete noDuration.durationMs;
    const rows: unknown[] = [
      revlogRow({ seq: 1 }),
      noDuration,
      { ...revlogRow(), seq: 'x' },
      { ...revlogRow(), seq: 1.5 },
      { ...revlogRow(), cardId: '' },
      { ...revlogRow(), rating: 'meh' },
      { ...revlogRow(), bucket: 'cram' },
      { ...revlogRow(), ivlAfter: null },
      { ...revlogRow(), durationMs: 'slow' },
      null,
      'row',
    ];
    const doc = { ...makeBackupEnvelope(makeState(), META), revlog: rows };
    const result = decodeBackup(JSON.stringify(doc), fakeMigrate().migrate, NOW);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.revlog).toEqual([revlogRow({ seq: 1 }), revlogRow({ seq: 5, durationMs: null })]);
    expect(result.skipped.revlog).toBe(9);
  });

  test('images with a name that could leave the media folder are left out and counted', () => {
    const safe: BackupMedia = { deckId: 'deck-1', name: 'map.png', base64: 'AAAA' };
    const media: unknown[] = [
      safe,
      { deckId: 'deck-1', name: '../../files/state.json', base64: 'AAAA' },
      { deckId: '..', name: 'map.png', base64: 'AAAA' },
      { deckId: 'deck-1/../..', name: 'x.png', base64: 'AAAA' },
      { deckId: 'deck-1', name: 'a\\b.png', base64: 'AAAA' },
      { deckId: 'deck-1', name: 'nul\0.png', base64: 'AAAA' },
      { deckId: 'deck-1', name: '', base64: 'AAAA' },
      { deckId: 'deck-1', name: 'map.png', base64: 42 },
      'image',
    ];
    const doc = { ...makeBackupEnvelope(makeState(), META), media };
    const result = decodeBackup(JSON.stringify(doc), fakeMigrate().migrate, NOW);
    expect(result.kind === 'ok' && result.media).toEqual([safe]);
    expect(result.kind === 'ok' && result.skipped.media).toBe(8);
  });
});

describe('decodeBackup — old raw exports (no envelope)', () => {
  test("today's backup.ts output (the raw state JSON) is accepted", () => {
    const state = buildSeedState(NOW);
    const { migrate, calls } = fakeMigrate();
    const result = decodeBackup(serialize(state), migrate, NOW);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.info).toEqual({ format: 'raw', exportedAt: null, app: null, schemaVersion: null });
    expect(result.state).toEqual({ ...JSON.parse(serialize(state)), migrated: true });
    expect(result.revlog).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  test.each(STATE_FIXTURES)('the saved document %s is handed to migrate as it is', (name) => {
    const { migrate, calls } = fakeMigrate();
    const result = decodeBackup(stateFixtureRaw(name), migrate, NOW);
    expect(calls).toHaveLength(1);
    expect(calls[0].doc).toEqual(stateFixture(name));
    expect(result.kind).toBe('ok');
    // v0 documents (v2.0.x and the German fork) come from version 0, main from 1.
    expect(result.kind === 'ok' && result.from).toBe(name.startsWith('v0') ? 0 : 1);
  });
});

describe('decodeBackup — not a Maranki backup', () => {
  test('text that is not JSON → invalid, migrate is never called', () => {
    const { migrate, calls } = fakeMigrate();
    const truncated = encodeBackup(makeState(), META).slice(0, 200);
    for (const text of ['', ' ', 'not json', '{"cards":[1,2', truncated, '\uFEFF']) {
      expect(decodeBackup(text, migrate, NOW)).toEqual({ kind: 'invalid' });
    }
    expect(calls).toHaveLength(0);
  });

  test('JSON that is not an object → invalid, migrate is never called', () => {
    const { migrate, calls } = fakeMigrate();
    for (const text of ['42', '[]', '[{"cards":[]}]', 'null', '"maranki"', 'true']) {
      expect(decodeBackup(text, migrate, NOW)).toEqual({ kind: 'invalid' });
    }
    expect(calls).toHaveLength(0);
  });

  test("an object migrate does not recognise → migrate's invalid passes through", () => {
    const { migrate, calls } = fakeMigrate();
    expect(decodeBackup('{"hello":"world"}', migrate, NOW)).toEqual({ kind: 'invalid' });
    expect(decodeBackup('{"format":"other-app","data":{}}', migrate, NOW)).toEqual({ kind: 'invalid' });
    expect(calls).toHaveLength(2);
  });
});

describe('decodeBackup — delegation to migrate', () => {
  test("migrate's too-new passes through unchanged (raw and enveloped)", () => {
    const tooNew = { ...makeState(), schemaVersion: 9, minReaderVersion: 9 };
    expect(decodeBackup(JSON.stringify(tooNew), fakeMigrate().migrate, NOW)).toEqual({
      kind: 'too-new',
      version: 9,
    });
    expect(decodeBackup(encodeBackup(tooNew, META), fakeMigrate().migrate, NOW)).toEqual({
      kind: 'too-new',
      version: 9,
    });
  });

  test('a newer document that this build may read (minReaderVersion 2) restores', () => {
    const readable = { ...makeState(), schemaVersion: 9, minReaderVersion: 2 };
    const result = decodeBackup(encodeBackup(readable, META), fakeMigrate().migrate, NOW);
    expect(result.kind === 'ok' && result.from).toBe(9);
  });

  test('whatever migrate answers is what decode answers', () => {
    const answers: MigrateResult<Doc>[] = [
      { kind: 'ok', state: { replaced: true }, from: 0, repaired: ['card c1: ease was NaN'] },
      { kind: 'too-new', version: 4 },
      { kind: 'invalid' },
    ];
    for (const answer of answers) {
      const result = decodeBackup(encodeBackup(makeState(), META), fakeMigrate(() => answer).migrate, NOW);
      if (answer.kind === 'ok') {
        expect(result.kind === 'ok' && [result.state, result.from, result.repaired]).toEqual([
          answer.state,
          answer.from,
          answer.repaired,
        ]);
      } else {
        expect(result).toEqual(answer);
      }
    }
  });

  test('a throw inside migrate is not hidden: decodeBackup throws it (a bug, not a bad file)', () => {
    const boom = new Error('migrate bug');
    const { migrate } = fakeMigrate(() => {
      throw boom;
    });
    expect(() => decodeBackup(encodeBackup(makeState(), META), migrate, NOW)).toThrow(boom);
    expect(() => decodeBackup(serialize(buildSeedState(NOW)), migrate, NOW)).toThrow(boom);
  });
});

// Wave 5d (L8): this module's old UTC helpers (fileStamp, backupFileName) are gone. Every backup
// name is made by src/store/backup.ts in the phone's LOCAL time, so these tests check THAT name.
describe('backup file names: the phone’s local time (wave 5d, L8)', () => {
  /** 21 Oct 2026, 18:04:07 on the phone's own clock, in whatever time zone the test machine runs. */
  const at = new Date(2026, 9, 21, 18, 4, 7).getTime();

  test('one prefix per kind (spec §8.4), and the stamp is YYYY-MM-DD-HH-mm-ss in LOCAL time', () => {
    expect(localBackupFileName('export', at)).toBe('maranki-backup-2026-10-21-18-04-07.json');
    expect(localBackupFileName('auto', at)).toBe('auto-2026-10-21-18-04-07.json');
    expect(localBackupFileName('beforeRestore', at)).toBe('before-restore-2026-10-21-18-04-07.json');
    // The prefixes still live here (the one list of kinds).
    expect(backupFileModule.BACKUP_PREFIX).toEqual({ export: 'maranki-backup-', auto: 'auto-', beforeRestore: 'before-restore-' });
  });

  test('names of one kind sort in time order, and each name reads back as its moment', () => {
    const times = [at, at + 1000, at + 86_400_000 * 40, at + 86_400_000 * 400];
    const names = times.map((t) => localBackupFileName('auto', t));
    expect([...names].sort()).toEqual(names);
    expect(names.map((name) => stampTimeOf(name))).toEqual(times);
  });

  test('this module makes no file name of its own: a UTC name cannot come back (L8)', () => {
    const exported = Object.keys(backupFileModule);
    expect(exported).not.toContain('fileStamp');
    expect(exported).not.toContain('backupFileName');
  });

  /**
   * A guard (a source check, like src/domain/face.test.ts): `toISOString()`
   * gives a UTC time, so it is the usual way a UTC file name comes back.
   * Only two app files may use it, each for a name the learner never sees
   * or only READS: src/store/backup.ts (`backupStamp`: the kv store's copies
   * of corrupt data inside the app, and reading the backup names of builds
   * before wave 5b) and src/store/premigrate.ts (the copies inside the app
   * before a migration, named with a "Z" for UTC). A new use fails here:
   * name the file in LOCAL time (backup.ts `localFileStamp`) instead.
   */
  test('no other app file builds a UTC time with toISOString() (a file name the learner sees is local time)', () => {
    const SRC = path.resolve(__dirname, '..');
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__fixtures__' && entry.name !== 'node_modules') walk(full);
        } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          if (/\btoISOString\(\)/.test(fs.readFileSync(full, 'utf8'))) found.push(path.relative(SRC, full).split(path.sep).join('/'));
        }
      }
    };
    walk(SRC);
    expect(found.sort()).toEqual(['store/backup.ts', 'store/premigrate.ts']);
  });

  test('isSafeFileName accepts plain names only', () => {
    for (const ok of ['map.png', 'deck-1', 'Ünïcode 東京.jpg', '.hidden', 'a..b']) {
      expect(isSafeFileName(ok)).toBe(true);
    }
    for (const bad of ['', '.', '..', 'a/b', '../x', 'a\\b', 'x\0y', 'x'.repeat(256), 42, null]) {
      expect(isSafeFileName(bad)).toBe(false);
    }
  });
});
