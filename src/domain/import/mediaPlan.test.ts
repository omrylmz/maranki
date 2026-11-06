/**
 * The media plan (spec §5.8, unit W2-5): only REFERENCED images, the total
 * size, the "> 50 MB → ask first" flag, audio counted but not imported,
 * file names that could leave the deck's media folder refused, and one
 * folder per deck (`planDeckMedia`).
 */
import { describe, expect, test } from '@jest/globals';

import { ankiFixture } from '../../test/factories';
import {
  archiveNameIn,
  contentHash,
  freeImageName,
  imageRefs,
  isImageName,
  isSafeMediaName,
  MEDIA_ASK_BYTES,
  mediaFolder,
  planDeckMedia,
  planMedia,
  renameImageRefs,
  soundRefs,
  uniqueImageName,
  type MediaPlanInput,
} from './mediaPlan';

function input(over: Partial<MediaPlanInput>): MediaPlanInput {
  return { fieldValues: [], manifest: {}, sizeOf: () => 100, include: true, ...over };
}

describe('references', () => {
  test('imageRefs reads double, single and bare src values and decodes entities', () => {
    expect(imageRefs('<b>A</b><img src="a.png"><IMG alt="x" SRC=\'b c.jpg\'><img src=d.gif>')).toEqual([
      'a.png',
      'b c.jpg',
      'd.gif',
    ]);
    expect(imageRefs('<img src="Tom &amp; Jerry.png">')).toEqual(['Tom & Jerry.png']);
  });

  test('imageRefs skips web addresses and inline data', () => {
    expect(imageRefs('<img src="https://x.org/a.png"><img src="data:image/png;base64,AAA"><img src="//cdn/a.png">')).toEqual(
      [],
    );
    expect(imageRefs('no images here')).toEqual([]);
  });

  test('soundRefs reads [sound:x] tags', () => {
    expect(soundRefs('Haus [sound:haus.mp3] [sound: b.ogg ]')).toEqual(['haus.mp3', 'b.ogg']);
    expect(soundRefs('[image:x.png]')).toEqual([]);
  });

  test('isImageName and isSafeMediaName', () => {
    expect(isImageName('diagram.SVG')).toBe(true);
    expect(isImageName('word.mp3')).toBe(false);
    expect(isImageName('.png')).toBe(false);
    expect(isSafeMediaName('example.webp')).toBe(true);
    for (const bad of ['', '.', '..', '../x.png', 'a/b.png', 'a\\b.png', '.hidden.png', 'c:x.png', 'a\0.png']) {
      expect(isSafeMediaName(bad)).toBe(false);
    }
    expect(mediaFolder('d-1')).toBe('media/d-1');
  });
});

describe('planMedia', () => {
  test('only images the notes reference AND the manifest lists; each file once', () => {
    const plan = planMedia(
      input({
        fieldValues: ['<img src="a.png"> and <img src="a.png">', '<img src="b.webp">', '<img src="not-listed.png">'],
        manifest: { '0': 'a.png', '1': 'b.webp', '2': 'unused.png' },
        sizeOf: (name) => ({ 'a.png': 1000, 'b.webp': 250, 'unused.png': 5 })[name] ?? null,
      }),
    );
    expect(plan.files).toEqual(['a.png', 'b.webp']);
    expect(plan.bytes).toBe(1250);
    expect(plan.found).toBe(2);
    expect(plan.foundBytes).toBe(1250);
    expect(plan.missing).toEqual(['not-listed.png']);
    expect(plan.askFirst).toBe(false);
  });

  test('a listed name missing from the archive, or a non-image, is not planned', () => {
    const plan = planMedia(
      input({
        fieldValues: ['<img src="gone.png"><img src="clip.mp3">'],
        manifest: { '0': 'gone.png', '1': 'clip.mp3' },
        sizeOf: (name) => (name === 'gone.png' ? null : 10),
      }),
    );
    expect(plan.files).toEqual([]);
    expect(plan.missing).toEqual(['gone.png', 'clip.mp3']);
  });

  test('more than 50 MB → askFirst', () => {
    const big = planMedia(
      input({
        fieldValues: ['<img src="a.png"><img src="b.png">'],
        manifest: { '0': 'a.png', '1': 'b.png' },
        sizeOf: () => MEDIA_ASK_BYTES / 2 + 1,
      }),
    );
    expect(big.askFirst).toBe(true);
    expect(big.foundBytes).toBe(MEDIA_ASK_BYTES + 2);
    const exactly = planMedia(
      input({ fieldValues: ['<img src="a.png">'], manifest: { '0': 'a.png' }, sizeOf: () => MEDIA_ASK_BYTES }),
    );
    expect(exactly.askFirst).toBe(false);
  });

  test('"Include images" off → nothing written, but everything still counted', () => {
    const plan = planMedia(
      input({ fieldValues: ['<img src="a.png">'], manifest: { '0': 'a.png' }, sizeOf: () => 70, include: false }),
    );
    expect(plan.files).toEqual([]);
    expect(plan.bytes).toBe(0);
    expect(plan.found).toBe(1);
    expect(plan.foundBytes).toBe(70);
  });

  test('a name that could leave the media folder is refused, even when listed', () => {
    const plan = planMedia(
      input({ fieldValues: ['<img src="../../evil.png">'], manifest: { '0': '../../evil.png' } }),
    );
    expect(plan.files).toEqual([]);
    expect(plan.unsafe).toEqual(['../../evil.png']);
  });

  test('a %-escaped src finds the plain manifest name', () => {
    const plan = planMedia(input({ fieldValues: ['<img src="my%20pic.png">'], manifest: { '0': 'my pic.png' } }));
    expect(plan.files).toEqual(['my pic.png']);
  });

  test('audio clips are counted (distinct names) and never planned', () => {
    const plan = planMedia(
      input({
        fieldValues: ['[sound:a.mp3]', '[sound:a.mp3] [sound:b.mp3]'],
        manifest: { '0': 'a.mp3', '1': 'b.mp3' },
      }),
    );
    expect(plan.audioClips).toBe(2);
    expect(plan.audio).toEqual(['a.mp3', 'b.mp3']);
    expect(plan.files).toEqual([]);
  });

  test('Algo_Patterns fixture: 10 referenced diagrams out of 57 in the manifest', () => {
    const fx = ankiFixture('algo_patterns');
    expect(Object.keys(fx.media)).toHaveLength(57);
    const plan = planMedia({
      fieldValues: fx.notes.flatMap((n) => n.flds.split('\x1f')),
      manifest: fx.media,
      sizeOf: () => 84_000,
      include: true,
    });
    expect(plan.files).toHaveLength(10);
    expect(plan.missing).toEqual([]);
    expect(plan.files).toContain('picture-1.svg');
    expect(plan.foundBytes).toBe(10 * 84_000);
  });
});

describe('planDeckMedia — one folder per deck', () => {
  const manifest = { '0': 'a.png', '1': 'b.png', '2': 'c.png' };

  test('each deck gets the images of its own notes; a file used by two decks goes to both', () => {
    const plan = planDeckMedia({
      decks: [
        { deckId: 'new', fieldValues: ['<img src="a.png">', '[sound:x.mp3]'] },
        { deckId: 'old', fieldValues: ['<img src="a.png"><img src="b.png">', '[sound:x.mp3] [sound:y.mp3]'] },
        { deckId: 'none', fieldValues: ['plain text'] },
      ],
      manifest,
      sizeOf: () => 10,
      include: true,
    });
    expect(plan.folders).toEqual([
      { deckFolder: 'media/new', files: ['a.png'] },
      { deckFolder: 'media/old', files: ['a.png', 'b.png'] },
    ]);
    expect(plan).toMatchObject({ bytes: 30, found: 3, foundBytes: 30, askFirst: false, audioClips: 2 });
  });

  test('the same deck listed twice is planned once; include off → no folders, still counted', () => {
    const decks = [
      { deckId: 'd', fieldValues: ['<img src="a.png">'] },
      { deckId: 'd', fieldValues: ['<img src="a.png"><img src="c.png">'] },
    ];
    expect(planDeckMedia({ decks, manifest, sizeOf: () => 5, include: true }).folders).toEqual([
      { deckFolder: 'media/d', files: ['a.png', 'c.png'] },
    ]);
    const off = planDeckMedia({ decks, manifest, sizeOf: () => 5, include: false });
    expect(off).toMatchObject({ folders: [], bytes: 0, found: 2, foundBytes: 10 });
  });

  test('askFirst looks at the bytes of every folder together', () => {
    const plan = planDeckMedia({
      decks: [
        { deckId: 'x', fieldValues: ['<img src="a.png">'] },
        { deckId: 'y', fieldValues: ['<img src="b.png">'] },
      ],
      manifest,
      sizeOf: () => MEDIA_ASK_BYTES / 2 + 1,
      include: true,
    });
    expect(plan.askFirst).toBe(true);
  });
});

/* ------------------------------------------------------------------- H2 */

describe('H2: manifest keys and file names like "__proto__" or "constructor"', () => {
  test('a manifest with no prototype and tricky keys or names is planned like any other', () => {
    // The .apkg reader gives the manifest without a prototype, so "__proto__" is an ordinary key.
    const manifest = Object.create(null) as Record<string, string>;
    manifest['__proto__'] = 'constructor.png';
    manifest['constructor'] = '__proto__.png';
    manifest['0'] = 'toString.png';
    const plan = planMedia(
      input({
        fieldValues: ['<img src="constructor.png"><img src="__proto__.png">', '<img src="toString.png"><img src="valueOf.png">'],
        manifest,
      }),
    );
    expect(plan.files).toEqual(['constructor.png', '__proto__.png', 'toString.png']);
    expect(plan.missing).toEqual(['valueOf.png']); // not in the manifest: Object's methods do not count
    const decks = planDeckMedia({
      decks: [{ deckId: '__proto__', fieldValues: ['<img src="constructor.png">'] }],
      manifest,
      sizeOf: () => 10,
      include: true,
    });
    expect(decks.folders).toEqual([{ deckFolder: 'media/__proto__', files: ['constructor.png'] }]);
  });
});

describe('one name, one picture (the helpers)', () => {
  const A = Uint8Array.of(1, 2, 3);
  const B = Uint8Array.of(4, 5, 6, 7);
  test('contentHash and uniqueImageName are stable and keep the file ending', () => {
    expect(contentHash(A)).toBe(contentHash(Uint8Array.of(1, 2, 3)));
    expect(contentHash(A)).not.toBe(contentHash(B));
    expect(contentHash(A)).toMatch(/^[0-9a-f]{8}$/);
    expect(uniqueImageName('image1.jpg', A)).toBe(`image1-${contentHash(A)}.jpg`);
    expect(uniqueImageName('image1.jpg', A, 2)).toBe(`image1-${contentHash(A)}-2.jpg`);
    expect(uniqueImageName(`${'x'.repeat(300)}.png`, A).length).toBeLessThanOrEqual(255);
    expect(isSafeMediaName(uniqueImageName('a b.png', A))).toBe(true);
  });

  test('freeImageName: free or the same bytes keeps the name; other bytes get a name of their own that fits', () => {
    const folder = (files: Record<string, Uint8Array>) => ({
      size: (n: string) => (Object.prototype.hasOwnProperty.call(files, n) ? files[n].length : null),
      read: (n: string) => (Object.prototype.hasOwnProperty.call(files, n) ? files[n] : null),
    });
    expect(freeImageName('a.png', A, [folder({})])).toBe('a.png');
    expect(freeImageName('a.png', A, [folder({ 'a.png': Uint8Array.of(1, 2, 3) })])).toBe('a.png');
    expect(freeImageName('a.png', A, [folder({ 'a.png': B })])).toBe(uniqueImageName('a.png', A));
    // The same size but other bytes is another picture too.
    expect(freeImageName('a.png', A, [folder({ 'a.png': Uint8Array.of(9, 9, 9) })])).toBe(uniqueImageName('a.png', A));
    // The own name is taken by yet another picture (a hash clash): the next one.
    const clash = folder({ 'a.png': B, [uniqueImageName('a.png', A)]: B });
    expect(freeImageName('a.png', A, [clash])).toBe(uniqueImageName('a.png', A, 2));
    // It must fit in EVERY folder.
    expect(freeImageName('a.png', A, [folder({}), folder({ 'a.png': B })])).toBe(uniqueImageName('a.png', A));
  });

  test('renameImageRefs rewrites only the src of the named images, in the quotes they had', () => {
    const to = (map: Record<string, string>) => (n: string) =>
      Object.prototype.hasOwnProperty.call(map, n) ? map[n] : undefined;
    expect(renameImageRefs('<img src="a.png"> A <img src="b.png">', to({ 'a.png': 'a-1.png' }))).toBe(
      '<img src="a-1.png"> A <img src="b.png">',
    );
    expect(renameImageRefs("<IMG alt='x' SRC='a b.png' width=3>", to({ 'a b.png': 'a b-1.png' }))).toBe(
      "<IMG alt='x' SRC='a b-1.png' width=3>",
    );
    expect(renameImageRefs('<img src=a.png>', to({ 'a.png': 'a-1.png' }))).toBe('<img src=a-1.png>');
    expect(renameImageRefs('<img src="R&amp;D.png">', to({ 'R&D.png': 'R&D-1.png' }))).toBe('<img src="R&amp;D-1.png">');
    expect(renameImageRefs('<img src="https://x.org/a.png">', to({ 'https://x.org/a.png': 'z.png' }))).toBe(
      '<img src="https://x.org/a.png">',
    );
    expect(renameImageRefs('no image', to({}))).toBe('no image');
    // imageRefs reads the new name back.
    expect(imageRefs(renameImageRefs('<img src="a.png">', to({ 'a.png': 'a-1.png' })))).toEqual(['a-1.png']);
  });

  test('archiveNameIn reads a renamed file by its archive name', () => {
    const folder = { deckFolder: 'media/d', files: ['a-1.png', 'b.png'], renamed: [{ name: 'a-1.png', from: 'a.png' }] };
    expect(archiveNameIn(folder, 'a-1.png')).toBe('a.png');
    expect(archiveNameIn(folder, 'b.png')).toBe('b.png');
    expect(archiveNameIn({}, 'b.png')).toBe('b.png');
  });
});
