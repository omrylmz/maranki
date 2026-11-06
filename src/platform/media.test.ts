/**
 * Tests for the imported-images helpers (src/platform/media.ts, spec §5.8,
 * §8.4, unit W3-3): write the plan's images after an import, copy them for a
 * duplicated deck, delete them with a deck, read them for a backup and write
 * them back on a restore.
 *
 * expo-file-system has no real implementation under jest, so it is replaced
 * by a small in-memory file tree (the `jest.mock` below) with the SDK 56
 * behaviour media.ts relies on: `File` / `Directory` made from parts,
 * `create`, `write` (bytes, or text with the base64 encoding), `moveSync`,
 * async `copy`, `bytesSync()`, `delete` (a folder: with everything in it),
 * `list()`, `size`, `base64()`.
 */
// '@jest/globals' first: the jest.mock factory below uses its `jest`.
import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import * as FileSystem from 'expo-file-system';

import {
  copyDeckMedia,
  deckIdOfFolder,
  deleteDeckMedia,
  listDeckMedia,
  mediaFileUri,
  mergeDeckMedia,
  mediaForBackup,
  moveImageNames,
  writeAfterSave,
  writeBackupMedia,
  writeImportMedia,
} from './media';
import { uniqueImageName } from '../domain/import/mediaPlan';
import type { FlushResult } from '../store/actions';

/* ------------------------------------------------------------ module mock */

interface FakeFs {
  files: Map<string, Uint8Array>;
  dirs: Set<string>;
  /** Names whose write throws (a full disk). */
  failNames: Set<string>;
}

jest.mock('expo-file-system', () => {
  const fs: FakeFs = { files: new Map(), dirs: new Set(['file:///docs']), failNames: new Set() };
  const uriOf = (parts: unknown[]) =>
    parts.map((p) => (typeof p === 'string' ? p : (p as { uri: string }).uri).replace(/\/+$/, '')).join('/');
  const parentOf = (uri: string) => uri.slice(0, uri.lastIndexOf('/'));
  const nameOf = (uri: string) => uri.slice(uri.lastIndexOf('/') + 1);

  class File {
    uri: string;
    constructor(...parts: unknown[]) {
      this.uri = uriOf(parts);
    }
    get name() {
      return nameOf(this.uri);
    }
    get exists() {
      return fs.files.has(this.uri);
    }
    get size() {
      return fs.files.get(this.uri)?.length ?? 0;
    }
    create() {
      if (!fs.dirs.has(parentOf(this.uri))) throw new Error(`no folder for ${this.uri}`);
      fs.files.set(this.uri, new Uint8Array());
    }
    write(content: string | Uint8Array, options?: { encoding?: string }) {
      if (fs.failNames.has(nameOf(this.uri).replace(/\.tmp$/, ''))) throw new Error('disk full');
      const bytes =
        typeof content === 'string'
          ? new Uint8Array(Buffer.from(content, options?.encoding === 'base64' ? 'base64' : 'utf8'))
          : content;
      fs.files.set(this.uri, bytes);
    }
    moveSync(dest: { uri: string }) {
      const bytes = fs.files.get(this.uri);
      if (!bytes) throw new Error(`no file ${this.uri}`);
      fs.files.delete(this.uri);
      fs.files.set(dest.uri, bytes);
      this.uri = dest.uri;
    }
    async copy(dest: { uri: string }) {
      const bytes = fs.files.get(this.uri);
      if (!bytes) throw new Error(`no file ${this.uri}`);
      if (!fs.dirs.has(parentOf(dest.uri))) throw new Error(`no folder for ${dest.uri}`);
      if (fs.failNames.has(nameOf(dest.uri))) throw new Error('disk full');
      fs.files.set(dest.uri, new Uint8Array(bytes));
    }
    bytesSync() {
      const bytes = fs.files.get(this.uri);
      if (!bytes) throw new Error(`no file ${this.uri}`);
      return new Uint8Array(bytes);
    }
    delete() {
      if (!fs.files.delete(this.uri)) throw new Error(`no file ${this.uri}`);
    }
    async base64() {
      const bytes = fs.files.get(this.uri);
      if (!bytes) throw new Error(`no file ${this.uri}`);
      return Buffer.from(bytes).toString('base64');
    }
  }

  class Directory {
    readonly uri: string;
    constructor(...parts: unknown[]) {
      this.uri = uriOf(parts);
    }
    get exists() {
      return fs.dirs.has(this.uri);
    }
    create() {
      // intermediates: make every parent too
      let uri = this.uri;
      while (uri.startsWith('file:///docs') && !fs.dirs.has(uri)) {
        fs.dirs.add(uri);
        uri = parentOf(uri);
      }
    }
    delete() {
      for (const uri of [...fs.files.keys()]) if (uri.startsWith(`${this.uri}/`)) fs.files.delete(uri);
      for (const uri of [...fs.dirs]) if (uri === this.uri || uri.startsWith(`${this.uri}/`)) fs.dirs.delete(uri);
    }
    list() {
      const out: (File | Directory)[] = [];
      for (const uri of fs.files.keys()) if (parentOf(uri) === this.uri) out.push(new File(uri));
      for (const uri of fs.dirs) if (parentOf(uri) === this.uri) out.push(new Directory(uri));
      return out;
    }
  }

  return { File, Directory, Paths: { document: new Directory('file:///docs') }, __fs: fs };
});

/** The fake file tree behind the mock. */
const fake = (FileSystem as unknown as { __fs: FakeFs }).__fs;

const DIR = 'file:///docs/media';
const bytes = (...values: number[]) => new Uint8Array(values);

beforeEach(() => {
  fake.files.clear();
  fake.dirs.clear();
  fake.dirs.add('file:///docs');
  fake.failNames.clear();
});

/* ------------------------------------------------------------------ tests */

describe('writeImportMedia (after the import was saved)', () => {
  test('writes each planned image to media/<deckId>/<name>, through a .tmp file', () => {
    const archive: Record<string, Uint8Array> = { 'a.png': bytes(1, 2, 3), 'b.webp': bytes(4) };
    const report = writeImportMedia([{ deckFolder: 'media/d1', files: ['a.png', 'b.webp', 'gone.png'] }], (n) => archive[n] ?? null);
    expect(report).toEqual({ written: 2, bytes: 4, missing: ['gone.png'], failed: [] });
    expect(fake.files.get(`${DIR}/d1/a.png`)).toEqual(bytes(1, 2, 3));
    expect([...fake.files.keys()].some((k) => k.endsWith('.tmp'))).toBe(false);
    expect(mediaFileUri('d1', 'a.png')).toBe(`${DIR}/d1/a.png`);
    expect(mediaFileUri('d1', 'gone.png')).toBeNull();
  });

  test('an unsafe name or folder is never written; one failing file does not stop the others', () => {
    fake.failNames.add('bad.png');
    const report = writeImportMedia(
      [
        { deckFolder: 'media/d1', files: ['../evil.png', 'bad.png', 'ok.png'] },
        { deckFolder: 'media/../x', files: ['y.png'] },
      ],
      () => bytes(9),
    );
    expect(report.written).toBe(1);
    expect(report.failed.sort()).toEqual(['../evil.png', 'bad.png', 'y.png']);
    expect([...fake.files.keys()]).toEqual([`${DIR}/d1/ok.png`]);
  });

  test('deckIdOfFolder only accepts media/<one safe name>', () => {
    expect(deckIdOfFolder('media/d-12')).toBe('d-12');
    expect(deckIdOfFolder('media/a/b')).toBeNull();
    expect(deckIdOfFolder('other/d1')).toBeNull();
    expect(deckIdOfFolder('media/..')).toBeNull();
  });
});

describe('copy and delete with the deck (after the save)', () => {
  test('copyDeckMedia copies every image of a deck into the new deck\'s folder', async () => {
    writeImportMedia([{ deckFolder: 'media/d1', files: ['a.png', 'b.png'] }], () => bytes(7, 7));
    await expect(copyDeckMedia('d1', 'd2')).resolves.toBe(2);
    expect(listDeckMedia('d2')).toEqual([
      { name: 'a.png', size: 2 },
      { name: 'b.png', size: 2 },
    ]);
    // The source stays.
    expect(listDeckMedia('d1')).toHaveLength(2);
    await expect(copyDeckMedia('empty', 'd3')).resolves.toBe(0);
  });

  test('deleteDeckMedia removes the deck\'s whole folder, and only that one', () => {
    writeImportMedia([{ deckFolder: 'media/d1', files: ['a.png'] }, { deckFolder: 'media/d2', files: ['b.png'] }], () => bytes(1));
    expect(deleteDeckMedia('d1')).toBe(true);
    expect(listDeckMedia('d1')).toEqual([]);
    expect(listDeckMedia('d2')).toHaveLength(1);
    expect(deleteDeckMedia('d1')).toBe(false);
    expect(deleteDeckMedia('../docs')).toBe(false);
  });

  // The engine's copy (engine.ts DeckMedia.copyDeckFolder): it removes the
  // old folder after a deck delete, so the copy must be complete or throw.
  test('mergeDeckMedia copies every image into the other deck, and never overwrites a file there', async () => {
    writeImportMedia([{ deckFolder: 'media/d1', files: ['a.png', 'same.png'] }], () => bytes(7, 7));
    writeImportMedia([{ deckFolder: 'media/d2', files: ['same.png', 'own.png'] }], () => bytes(7, 7));
    await expect(mergeDeckMedia('d1', 'd2')).resolves.toBeUndefined();
    expect(listDeckMedia('d2').map((f) => f.name)).toEqual(['a.png', 'own.png', 'same.png']);
    expect(listDeckMedia('d1')).toHaveLength(2); // the source stays
    // A deck with no images: nothing to copy, no error, no folder made.
    await expect(mergeDeckMedia('empty', 'd3')).resolves.toBeUndefined();
    expect(fake.dirs.has(`${DIR}/d3`)).toBe(false);
  });

  test('mergeDeckMedia throws when a file of the same name has other bytes, and keeps that file', async () => {
    writeImportMedia([{ deckFolder: 'media/d1', files: ['a.png', 'b.png'] }], () => bytes(1, 2));
    writeImportMedia([{ deckFolder: 'media/d2', files: ['a.png'] }], () => bytes(9));
    await expect(mergeDeckMedia('d1', 'd2')).rejects.toThrow('a.png');
    expect(Array.from(fake.files.get(`${DIR}/d2/a.png`)!)).toEqual([9]); // not overwritten
    expect(Array.from(fake.files.get(`${DIR}/d2/b.png`)!)).toEqual([1, 2]); // the others were copied
  });

  test('mergeDeckMedia throws when a copy fails (a full disk)', async () => {
    writeImportMedia([{ deckFolder: 'media/d1', files: ['a.png', 'b.png'] }], () => bytes(1));
    fake.failNames.add('b.png');
    await expect(mergeDeckMedia('d1', 'd2')).rejects.toThrow('b.png');
    expect(listDeckMedia('d2').map((f) => f.name)).toEqual(['a.png']);
  });

  // "Move to deck…" (engine.ts moveNotes → DeckMedia.copyDeckFolder with the
  // moved cards' image names): only those files go to the new deck, not the
  // whole folder (W4-7 review round 2).
  test('mergeDeckMedia with names copies ONLY those files, with the same never-overwrite rule', async () => {
    writeImportMedia([{ deckFolder: 'media/d1', files: ['map.png', 'other1.png', 'other2.png', 'same.png'] }], () =>
      bytes(4, 4),
    );
    writeImportMedia([{ deckFolder: 'media/d2', files: ['same.png'] }], () => bytes(4, 4));
    // 'gone.png' is not in d1 (the card shows its text without it): skipped, no error.
    await expect(mergeDeckMedia('d1', 'd2', ['map.png', 'same.png', 'gone.png'])).resolves.toBeUndefined();
    expect(listDeckMedia('d2').map((f) => f.name)).toEqual(['map.png', 'same.png']);
    expect(listDeckMedia('d1')).toHaveLength(4); // the source stays
    // No names → nothing to copy, and no folder is made.
    await expect(mergeDeckMedia('d1', 'd3', [])).resolves.toBeUndefined();
    expect(fake.dirs.has(`${DIR}/d3`)).toBe(false);
  });

  test('mergeDeckMedia with names throws only for a named file that is not in the other deck', async () => {
    writeImportMedia([{ deckFolder: 'media/d1', files: ['a.png', 'b.png'] }], () => bytes(1, 2));
    writeImportMedia([{ deckFolder: 'media/d2', files: ['a.png', 'b.png'] }], () => bytes(9));
    // b.png differs too, but it is not named: no error for it, and nothing is overwritten.
    const error = await mergeDeckMedia('d1', 'd2', ['a.png']).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain('a.png');
    expect(error?.message).not.toContain('b.png');
    expect(Array.from(fake.files.get(`${DIR}/d2/a.png`)!)).toEqual([9]);
    expect(Array.from(fake.files.get(`${DIR}/d2/b.png`)!)).toEqual([9]);
  });

  test('moveImageNames: a name the other deck holds with OTHER bytes gets a name of its own (free in both folders)', () => {
    writeImportMedia([{ deckFolder: 'media/d1', files: ['image1.jpg', 'same.png', 'free.png'] }], (n) =>
      n === 'image1.jpg' ? bytes(1, 1, 1) : bytes(5),
    );
    writeImportMedia([{ deckFolder: 'media/d2', files: ['image1.jpg', 'same.png'] }], (n) =>
      n === 'image1.jpg' ? bytes(2, 2, 2, 2) : bytes(5),
    );
    const names = moveImageNames('d1', 'd2', ['image1.jpg', 'same.png', 'free.png', 'gone.png']);
    expect([...names]).toEqual([['image1.jpg', uniqueImageName('image1.jpg', bytes(1, 1, 1))]]);
    // Every file of d1 when no names are given; a deck with no folder, or the same deck: nothing.
    expect([...moveImageNames('d1', 'd2').keys()]).toEqual(['image1.jpg']);
    expect(moveImageNames('d1', 'nowhere').size).toBe(0);
    expect(moveImageNames('d1', 'd1').size).toBe(0);
  });

  test('mergeDeckMedia with renamed copies the file under its new name into BOTH decks and keeps the other picture', async () => {
    writeImportMedia([{ deckFolder: 'media/d1', files: ['image1.jpg', 'b.png'] }], (n) =>
      n === 'image1.jpg' ? bytes(1, 1, 1) : bytes(3),
    );
    writeImportMedia([{ deckFolder: 'media/d2', files: ['image1.jpg'] }], () => bytes(2, 2, 2, 2));
    const renamed = moveImageNames('d1', 'd2', ['image1.jpg', 'b.png']);
    const own = renamed.get('image1.jpg') as string;
    await expect(mergeDeckMedia('d1', 'd2', ['image1.jpg', 'b.png'], renamed)).resolves.toBeUndefined();
    expect(Array.from(fake.files.get(`${DIR}/d2/image1.jpg`)!)).toEqual([2, 2, 2, 2]); // the other deck's picture stays
    expect(Array.from(fake.files.get(`${DIR}/d2/${own}`)!)).toEqual([1, 1, 1]); // the moved card's picture
    expect(Array.from(fake.files.get(`${DIR}/d1/${own}`)!)).toEqual([1, 1, 1]); // an Undo finds it in d1 too
    expect(Array.from(fake.files.get(`${DIR}/d2/b.png`)!)).toEqual([3]);
    // Again (the same copy waited for a save): nothing to overwrite, no error.
    await expect(mergeDeckMedia('d1', 'd2', ['image1.jpg', 'b.png'], renamed)).resolves.toBeUndefined();
    // A deck delete (no names) into d2: every file of d1 fits now (image1.jpg under its own
    // name), so the copy is complete and the old folder can go.
    await expect(mergeDeckMedia('d1', 'd2', undefined, moveImageNames('d1', 'd2'))).resolves.toBeUndefined();
    expect(listDeckMedia('d2').map((f) => f.name).sort()).toEqual([own, 'b.png', 'image1.jpg'].sort());
    expect(Array.from(fake.files.get(`${DIR}/d2/image1.jpg`)!)).toEqual([2, 2, 2, 2]);
  });

  test('listDeckMedia skips leftover .tmp files (a write that never finished)', () => {
    writeImportMedia([{ deckFolder: 'media/d1', files: ['a.png'] }], () => bytes(1));
    fake.files.set(`${DIR}/d1/half.png.tmp`, bytes(1));
    expect(listDeckMedia('d1').map((f) => f.name)).toEqual(['a.png']);
  });
});

describe('backups', () => {
  test('mediaForBackup reads the images as base64; writeBackupMedia writes them back', async () => {
    writeImportMedia([{ deckFolder: 'media/d1', files: ['a.png'] }], () => bytes(0, 255, 16));
    const out = await mediaForBackup(['d1', 'd9'], 50 * 1024 * 1024);
    expect(out).toEqual({ items: [{ deckId: 'd1', name: 'a.png', base64: 'AP8Q' }], bytes: 3, skipped: 0, tooBig: false });

    deleteDeckMedia('d1');
    const report = writeBackupMedia(out.items);
    expect(report).toMatchObject({ written: 1, failed: [] });
    expect(fake.files.get(`${DIR}/d1/a.png`)).toEqual(bytes(0, 255, 16));
  });

  test('over the size limit → no images (the backup is written without them)', async () => {
    writeImportMedia([{ deckFolder: 'media/d1', files: ['a.png'] }], () => new Uint8Array(100));
    await expect(mediaForBackup(['d1'], 99)).resolves.toEqual({ items: [], bytes: 100, skipped: 0, tooBig: true });
  });

  test('a restored item with an unsafe deck id or name, or not an image, is not written', () => {
    const report = writeBackupMedia([
      { deckId: '../x', name: 'a.png', base64: 'AA==' },
      { deckId: 'd1', name: 'a/b.png', base64: 'AA==' },
      { deckId: 'd1', name: 'script.js', base64: 'AA==' },
      { deckId: 'd1', name: 'ok.jpg', base64: 'AA==' },
    ]);
    expect(report.written).toBe(1);
    expect(report.failed).toHaveLength(3);
    expect([...fake.files.keys()]).toEqual([`${DIR}/d1/ok.jpg`]);
  });
});

describe('writeAfterSave — the images only after the save committed (W3-5 hardening)', () => {
  /** A fake actions.flush(): it answers the given results in order (then the last one again). */
  function flushes(...answers: FlushResult[]) {
    const calls: string[] = [];
    let n = 0;
    const flush = async (): Promise<FlushResult> => {
      const answer = answers[Math.min(n, answers.length - 1)];
      n += 1;
      calls.push(answer.ok ? 'flush:ok' : `flush:${answer.reason}`);
      return answer;
    };
    return { flush, calls };
  }
  const noWait = async () => undefined;
  const failed: FlushResult = { ok: false, reason: 'write', cause: new Error('disk full') };

  test('a save that commits: the write runs after it, once', async () => {
    const { flush, calls } = flushes({ ok: true });
    const out = await writeAfterSave(flush, () => {
      calls.push('write');
      return writeImportMedia([{ deckFolder: 'media/d1', files: ['a.png'] }], () => bytes(1));
    });
    expect(calls).toEqual(['flush:ok', 'write']);
    expect(out.saved).toEqual({ ok: true });
    expect(out.tries).toBe(1);
    expect(out.written?.written).toBe(1);
    expect(fake.files.has(`${DIR}/d1/a.png`)).toBe(true);
  });

  test('a failed save is tried again; the write runs only once a save committed', async () => {
    const { flush, calls } = flushes(failed, { ok: true });
    const waits: number[] = [];
    const out = await writeAfterSave(flush, () => calls.push('write'), {
      waitMs: 250,
      wait: async (ms) => {
        waits.push(ms);
      },
    });
    expect(calls).toEqual(['flush:write', 'flush:ok', 'write']);
    expect(waits).toEqual([250]);
    expect(out).toMatchObject({ saved: { ok: true }, tries: 2 });
  });

  test('a save that keeps failing: nothing is written, no folder is made, the caller gets the failure', async () => {
    const { flush, calls } = flushes(failed);
    const out = await writeAfterSave(
      flush,
      () => writeImportMedia([{ deckFolder: 'media/d-never-saved', files: ['a.png'] }], () => bytes(1)),
      { wait: noWait },
    );
    expect(calls).toEqual(['flush:write', 'flush:write', 'flush:write']); // 3 tries by default
    expect(out).toEqual({ saved: failed, written: null, tries: 3 });
    expect(fake.dirs.has(`${DIR}/d-never-saved`)).toBe(false);
    expect([...fake.files.keys()]).toEqual([]);
  });

  test('a blocked save (C1) is not tried again and writes nothing', async () => {
    const { flush, calls } = flushes({ ok: false, reason: 'blocked' });
    let wrote = false;
    const out = await writeAfterSave(
      flush,
      () => {
        wrote = true;
      },
      { tries: 5, wait: noWait },
    );
    expect(calls).toEqual(['flush:blocked']);
    expect(out).toEqual({ saved: { ok: false, reason: 'blocked' }, written: null, tries: 1 });
    expect(wrote).toBe(false);
  });

  test('tries: 1 saves once; an error of the write is passed on', async () => {
    const once = flushes(failed);
    await expect(writeAfterSave(once.flush, () => 'x', { tries: 1, wait: noWait })).resolves.toMatchObject({
      written: null,
      tries: 1,
    });
    expect(once.calls).toEqual(['flush:write']);
    const ok = flushes({ ok: true });
    await expect(
      writeAfterSave(ok.flush, () => {
        throw new Error('no space');
      }),
    ).rejects.toThrow('no space');
  });
});
