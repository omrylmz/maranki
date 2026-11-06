/**
 * Which image files an import brings along (spec §5.8, unit W2-5). Pure.
 *
 * An Anki field is HTML. An image in it looks like `<img src="example.webp">`.
 * The .apkg keeps the image bytes in its zip under numbered names ("0", "1" …)
 * and a small `media` manifest maps them back: "0" → "example.webp".
 *
 * The media plan answers four questions for the import preview:
 *   - which images do the chosen notes really use (only REFERENCED images,
 *     never every file in the archive)?
 *   - how many bytes are they (above 50 MB the preview asks first)?
 *   - which ones will be written (none when "Include images" is off)?
 *   - how many audio clips are there? Audio is not imported yet: `[sound:x]`
 *     stays in the field text and the preview says "{n} audio clips — not
 *     imported yet. Cards keep their text."
 *
 * The files are written AFTER the save commits, to `media/<deckId>/<name>`
 * (W3-3 `src/platform/media.ts`). `planDeckMedia` does this per deck: a note
 * updated where it is (in another deck) gets its images in THAT deck's
 * folder. A file name from a downloaded deck is untrusted data, so a name
 * that could leave that folder ("../x", "a/b") is never planned.
 *
 * Hermes-safe: no String.normalize / replaceAll / lookbehind. Linear regexes.
 */

/** Above this many bytes of images, the preview asks before importing them (§5.8). */
export const MEDIA_ASK_BYTES = 50 * 1024 * 1024;

/** File endings that count as images. Anything else (audio, fonts …) is never planned. */
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'heic', 'heif', 'tif', 'tiff', 'ico']);

/** The folder of one deck's images, relative to the app's document folder. */
export function mediaFolder(deckId: string): string {
  return `media/${deckId}`;
}

/** True when `name` ends with an image file ending ("diagram.SVG" → true, "word.mp3" → false). */
export function isImageName(name: string): boolean {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return false;
  return IMAGE_EXT.has(name.slice(dot + 1).toLowerCase());
}

/**
 * True when `name` is a plain file name that stays inside the deck's media
 * folder: not empty, no folder separators, not "." or "..", no NUL, not
 * hidden (".x"), and not absurdly long.
 */
export function isSafeMediaName(name: string): boolean {
  if (!name || name.length > 255) return false;
  if (name === '.' || name === '..' || name.charAt(0) === '.') return false;
  for (let i = 0; i < name.length; i++) {
    const ch = name.charAt(i);
    if (ch === '/' || ch === '\\' || ch === '\0' || ch === ':') return false;
  }
  return true;
}

/* --------------------------------------------------------------- references */

/** `<img ... src="x" ...>` — the src value in double quotes, single quotes or bare. */
const IMG_SRC_RE = /<img\b[^<>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+))[^<>]*>/gi;
/** `[sound:x]` — Anki's audio tag. */
const SOUND_RE = /\[sound:([^\][]*)\]/gi;

/** The few HTML entities that appear inside an Anki file name. */
function decodeNameEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * Every image file name in one field, in order, as written in `src`
 * (HTML entities decoded). Web addresses and inline data are skipped:
 * they are not files in the archive.
 *
 *   imageRefs('<b>A</b><img src="a.png"><img src=\'b c.jpg\'>') → ['a.png', 'b c.jpg']
 */
export function imageRefs(html: string): string[] {
  if (!html || html.indexOf('<') < 0) return [];
  const out: string[] = [];
  IMG_SRC_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IMG_SRC_RE.exec(html)) !== null) {
    const raw = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (!raw) continue;
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(raw)) continue; // http:, https:, data:, file:, //host
    out.push(decodeNameEntities(raw));
  }
  return out;
}

/**
 * Every audio clip name in one field, in order.
 *
 *   soundRefs('Haus [sound:haus.mp3]') → ['haus.mp3']
 */
export function soundRefs(text: string): string[] {
  if (!text || text.indexOf('[') < 0) return [];
  const out: string[] = [];
  SOUND_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SOUND_RE.exec(text)) !== null) {
    const name = m[1].trim();
    if (name) out.push(name);
  }
  return out;
}

/** Undo %XX escapes ("a%20b.png" → "a b.png"). A broken escape returns the input unchanged. */
function percentDecoded(name: string): string {
  if (name.indexOf('%') < 0) return name;
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/**
 * The archive file name an `<img src>` reference means: the reference itself
 * when the manifest lists it, else its %-decoded form (some tools escape it).
 */
export function archiveNameOf(ref: string, listed: ReadonlySet<string>): string {
  return listed.has(ref) ? ref : percentDecoded(ref);
}

/* ------------------------------------------------- one name, one picture */

/*
 * A deck folder never holds two different pictures under one name. Cards
 * show `<img src="image1.jpg">` from the folder of THEIR deck, so when an
 * import (or a move) brings an image1.jpg with OTHER bytes into a folder that
 * has one, the incoming file gets its own name (`uniqueImageName`:
 * "image1-1a2b3c4d.jpg", from its bytes) and the `<img src>` of the notes
 * that bring it is rewritten in the same step (`renameImageRefs`). Before, the
 * new file REPLACED the old one, and every card already in the deck showed
 * the wrong picture (and the old picture was lost). Like Anki, which renames
 * an incoming file whose name is taken by other content.
 */

/** FNV-1a (32 bit) of some bytes, as 8 hex digits. Not secure; only a short, stable name part. */
export function contentHash(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * The name a picture gets when its own name is taken by other bytes:
 * `<stem>-<contentHash>.<ext>`, and `-<k>` after the hash for the k-th try
 * (k ≥ 2: two pictures with the same hash). The same bytes always get the
 * same name, so importing the same file again finds the file it wrote before.
 *
 *   uniqueImageName('image1.jpg', bytes)    → 'image1-9c1f0a2b.jpg'
 *   uniqueImageName('image1.jpg', bytes, 2) → 'image1-9c1f0a2b-2.jpg'
 */
export function uniqueImageName(name: string, bytes: Uint8Array, k = 1): string {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot) : '';
  const tail = `-${contentHash(bytes)}${k > 1 ? `-${k}` : ''}${ext}`;
  const stem = (dot > 0 ? name.slice(0, dot) : name).slice(0, Math.max(1, 255 - tail.length));
  return `${stem}${tail}`;
}

/** What a deck folder holds under a name: `size` is null when there is no such file. */
export interface FolderProbe {
  size(name: string): number | null;
  /** The file's bytes, or null when it cannot be read. */
  read(name: string): Uint8Array | null;
}

/** True when two byte arrays are the same. */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * The name under which the picture `bytes` (called `name` where it comes
 * from) goes into the folders `probes` (it must fit in all of them): `name`
 * when no folder has a file of that name or each has these very bytes, else
 * the first `uniqueImageName` that fits. A file that cannot be read counts as
 * other bytes (it is never overwritten).
 */
export function freeImageName(name: string, bytes: Uint8Array, probes: readonly FolderProbe[]): string {
  const fits = (candidate: string) =>
    probes.every((p) => {
      const size = p.size(candidate);
      if (size === null) return true;
      if (size !== bytes.length) return false;
      const there = p.read(candidate);
      return there !== null && sameBytes(there, bytes);
    });
  if (fits(name)) return name;
  let k = 1;
  let candidate = uniqueImageName(name, bytes, k);
  while (!fits(candidate) && k < 1000) candidate = uniqueImageName(name, bytes, (k += 1));
  return candidate;
}

/**
 * The archive name to read one file of a plan folder by: its `renamed.from`
 * (the file got another name in the folder), else the name itself.
 */
export function archiveNameIn(folder: { renamed?: readonly { name: string; from: string }[] }, name: string): string {
  return folder.renamed?.find((r) => r.name === name)?.from ?? name;
}

/** A file name as an attribute value, in the quotes it had (`"`, `'`, or none). */
function srcValue(name: string, quote: string): string {
  const amp = name.replace(/&/g, '&amp;');
  if (quote === "'") return `'${amp.replace(/'/g, '&#39;')}'`;
  if (quote === '"' || /[\s"'<>=`]/.test(name)) return `"${amp.replace(/"/g, '&quot;')}"`;
  return amp;
}

/**
 * The field with the `src` of some images changed: `rename(name)` gets each
 * image name as `imageRefs` reads it (entities decoded) and returns its new
 * name, or undefined to keep it. Everything else stays as it is.
 *
 *   renameImageRefs('<img src="a.png"> A', (n) => (n === 'a.png' ? 'a-1.png' : undefined))
 *   → '<img src="a-1.png"> A'
 */
export function renameImageRefs(html: string, rename: (name: string) => string | undefined): string {
  if (!html || html.indexOf('<') < 0) return html;
  IMG_SRC_RE.lastIndex = 0;
  return html.replace(IMG_SRC_RE, (tag: string, dq?: string, sq?: string, bare?: string) => {
    const raw = dq ?? sq ?? bare ?? '';
    const ref = raw.trim();
    if (!ref || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(ref)) return tag;
    const next = rename(decodeNameEntities(ref));
    if (next === undefined) return tag;
    const quote = dq !== undefined ? '"' : sq !== undefined ? "'" : '';
    const written = `${quote}${raw}${quote}`;
    const at = tag.search(/\bsrc\s*=\s*/i);
    const valueAt = at < 0 ? -1 : tag.indexOf(written, at);
    if (valueAt < 0) return tag;
    return `${tag.slice(0, valueAt)}${srcValue(next, quote)}${tag.slice(valueAt + written.length)}`;
  });
}

/* --------------------------------------------------------------------- plan */

export interface MediaPlanInput {
  /** The raw field values of the notes that land in the target deck. */
  fieldValues: Iterable<string>;
  /** The archive's manifest: zip entry name → file name ("0" → "example.webp"). */
  manifest: Readonly<Record<string, string>>;
  /** Uncompressed size of a file (by file name), or null when the archive does not contain it. */
  sizeOf: (name: string) => number | null;
  /** choices.images ("Include images"). false → nothing is written, but everything is still counted. */
  include: boolean;
}

export interface MediaPlan {
  /** The image files to write, each name once, in first-use order. Empty when `include` is false. */
  files: string[];
  /** Total bytes of `files`. */
  bytes: number;
  /** Referenced images that the archive contains (written or not). */
  found: number;
  /** Total bytes of `found`. */
  foundBytes: number;
  /** foundBytes > MEDIA_ASK_BYTES: the preview asks first. */
  askFirst: boolean;
  /** Referenced image names that are not in the manifest or not in the archive (cards show no image). */
  missing: string[];
  /** Referenced names that were refused because they could leave the media folder. */
  unsafe: string[];
  /** Distinct audio clips referenced (not imported yet). = audio.length. */
  audioClips: number;
  /** Those clip names, each once, in first-use order. */
  audio: string[];
}

/**
 * Plan the images of an import. Only images that a note really references
 * AND that the manifest lists count; each file counts once, even when many
 * notes use it.
 */
export function planMedia(input: MediaPlanInput): MediaPlan {
  const listed = new Set<string>();
  for (const key of Object.keys(input.manifest)) {
    const name = input.manifest[key];
    if (typeof name === 'string' && name) listed.add(name);
  }

  const seen = new Set<string>();
  const sounds = new Set<string>();
  const found: string[] = [];
  const sizes = new Map<string, number>();
  const missing: string[] = [];
  const unsafe: string[] = [];

  for (const value of input.fieldValues) {
    for (const clip of soundRefs(value)) sounds.add(clip);
    for (const ref of imageRefs(value)) {
      // Anki writes the plain name; some tools write it %-escaped. Use the
      // form the manifest knows.
      const name = archiveNameOf(ref, listed);
      if (seen.has(name)) continue;
      seen.add(name);
      if (!isSafeMediaName(name)) {
        unsafe.push(name);
        continue;
      }
      if (!isImageName(name) || !listed.has(name)) {
        missing.push(name);
        continue;
      }
      const size = input.sizeOf(name);
      if (size === null || !Number.isFinite(size) || size < 0) {
        missing.push(name);
        continue;
      }
      found.push(name);
      sizes.set(name, size);
    }
  }

  let foundBytes = 0;
  for (const name of found) foundBytes += sizes.get(name) ?? 0;
  const files = input.include ? found : [];
  return {
    files,
    bytes: input.include ? foundBytes : 0,
    found: found.length,
    foundBytes,
    askFirst: foundBytes > MEDIA_ASK_BYTES,
    missing,
    unsafe,
    audioClips: sounds.size,
    audio: [...sounds],
  };
}

/* ------------------------------------------------------------- per deck */

/** The field values of the notes that one deck gets (or keeps) from an import. */
export interface DeckMediaInput {
  deckId: string;
  fieldValues: Iterable<string>;
}

export interface DeckMediaPlan {
  /**
   * One entry per deck folder that gets files, in the order of the input
   * (`media/<deckId>` + the file names to write there). A file that two
   * decks use is written into both folders.
   */
  folders: { deckFolder: string; files: string[] }[];
  /** Total bytes of every file in `folders`. */
  bytes: number;
  /** Referenced images that the archive contains, counted per deck folder (written or not). */
  found: number;
  /** Total bytes of `found`. */
  foundBytes: number;
  /** foundBytes > MEDIA_ASK_BYTES: the preview asks first. */
  askFirst: boolean;
  /** Distinct audio clips over all decks (not imported yet). */
  audioClips: number;
}

/**
 * Plan the images of an import whose notes land in SEVERAL decks: the new or
 * target deck, and the decks of notes that are updated where they are
 * (choices.elsewhere 'update'). Each deck's images go to its own folder,
 * because cards show the images of their own deck's folder. A deck whose
 * entry is listed twice is planned once (its values are joined).
 */
export function planDeckMedia(input: {
  decks: readonly DeckMediaInput[];
  manifest: Readonly<Record<string, string>>;
  sizeOf: (name: string) => number | null;
  include: boolean;
}): DeckMediaPlan {
  // Join the values of the same deck, keeping the first-seen deck order.
  const valuesByDeck = new Map<string, string[]>();
  for (const d of input.decks) {
    let list = valuesByDeck.get(d.deckId);
    if (!list) valuesByDeck.set(d.deckId, (list = []));
    for (const v of d.fieldValues) list.push(v);
  }
  const folders: DeckMediaPlan['folders'] = [];
  const clips = new Set<string>();
  let bytes = 0;
  let found = 0;
  let foundBytes = 0;
  for (const [deckId, fieldValues] of valuesByDeck) {
    const plan = planMedia({ fieldValues, manifest: input.manifest, sizeOf: input.sizeOf, include: input.include });
    if (plan.files.length > 0) folders.push({ deckFolder: mediaFolder(deckId), files: plan.files });
    bytes += plan.bytes;
    found += plan.found;
    foundBytes += plan.foundBytes;
    for (const clip of plan.audio) clips.add(clip);
  }
  return { folders, bytes, found, foundBytes, askFirst: foundBytes > MEDIA_ASK_BYTES, audioClips: clips.size };
}
