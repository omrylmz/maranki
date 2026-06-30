/**
 * AnkiWeb shared-decks network client — search for and download real shared decks.
 *
 * This talks to AnkiWeb's UNDOCUMENTED, reverse-engineered `/svc/shared/*` API.
 * It works UNAUTHENTICATED (no cookies), and every endpoint replies with BINARY
 * PROTOBUF (not JSON) — so the wire format is decoded by hand here with a tiny
 * varint / length-delimited reader (no protobuf runtime, no new dependency).
 *
 * Flow:
 *   searchSharedDecks(q)   GET list-decks                 -> AnkiWebDeck[]
 *   downloadSharedDeck(id) GET item-info (mints a single-use, time-limited
 *                          download token) -> GET download-deck?t=<token> -> .apkg bytes
 *   The returned .apkg bytes are handed to the existing parseApkg() in
 *   importApkg.ts, which turns them into importable cards.
 *
 * Token gotcha (a wrong slice yields HTTP 400 "Download link is invalid or
 * expired"): the download token is a length-PREFIXED protobuf string field, so
 * it must be sliced by its declared length — a greedy "scan base64url chars"
 * grabs one extra byte (the next field's tag) and corrupts the HMAC signature.
 *
 * Be gentle: one request per user action — hammering these endpoints 503s / hangs.
 */
import { strFromU8 } from 'fflate';

/** Single origin for every endpoint. */
const BASE = 'https://ankiweb.net';

/**
 * Reject any response bigger than this. The download endpoint returns a real
 * .apkg (media included), so the cap is generous — but it stops a hostile or
 * runaway body (or a zip-bomb-sized package) from exhausting memory.
 */
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024; // 64 MB

/* ------------------------------------------------------------------ types */

export interface AnkiWebDeck {
  /** Shared-deck id. Always < 2^32 but kept as a STRING for safe URL building. */
  id: string;
  name: string;
  notes: number;
  upvotes: number;
  downvotes: number;
  /** Last-modified time, unix SECONDS. */
  modifiedSec: number;
  audio: number;
  images: number;
}

export type AnkiWebErrorCode = 'network' | 'http' | 'empty' | 'token' | 'download';

export class AnkiWebError extends Error {
  /**
   * - network: fetch itself rejected (offline / DNS / TLS).
   * - http: a request returned a non-2xx status.
   * - empty: a response carried no usable decks (reserved for callers).
   * - token: item-info did not yield a valid download token.
   * - download: the download-deck request failed (link expired / server error).
   */
  code: AnkiWebErrorCode;
  constructor(code: AnkiWebErrorCode, message: string) {
    super(message);
    this.name = 'AnkiWebError';
    this.code = code;
  }
}

/* --------------------------------------------------------- protobuf reader */

/**
 * Read a base-128 varint at `pos`. Returns the decoded value and the index of
 * the byte just past it. Accumulates with multiplication (NOT `<<`): bit-shifts
 * in JS are 32-bit, which would overflow on ids up to 2^32 and unix-second
 * timestamps; every field we read fits in 2^53, so a Number stays exact.
 * A varint truncated by a short/corrupt buffer returns what it has so the
 * caller's loop terminates instead of spinning.
 */
function readVarint(bytes: Uint8Array, pos: number): [value: number, nextPos: number] {
  let value = 0;
  let multiplier = 1; // 128^0, then 128^1, 128^2, ...
  let p = pos;
  while (p < bytes.length) {
    const byte = bytes[p];
    p++;
    value += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) return [value, p]; // top bit clear ⇒ last byte
    multiplier *= 128;
  }
  return [value, p];
}

/**
 * Advance past a field whose value we don't care about, given its wire type:
 *   0 varint (length-delimited by its own continuation bits)
 *   1 64-bit  (fixed 8 bytes)
 *   2 length-delimited (a varint length prefix, then that many bytes)
 *   5 32-bit  (fixed 4 bytes)
 * An unknown wire type bails to the end of the buffer (defensive: never loop).
 */
function skipField(bytes: Uint8Array, pos: number, wireType: number): number {
  switch (wireType) {
    case 0:
      return readVarint(bytes, pos)[1];
    case 1:
      return pos + 8;
    case 2: {
      const [len, next] = readVarint(bytes, pos);
      return next + len;
    }
    case 5:
      return pos + 4;
    default:
      return bytes.length;
  }
}

/* ----------------------------------------------------- list-decks decoding */

/**
 * Decode one Deck submessage occupying bytes[start, end).
 * Fields (proto3, so any value equal to its zero default is OMITTED on the wire
 * — e.g. images / downvotes / audio simply do not appear when 0):
 *   1 varint id · 2 string name · 3 varint upvotes · 4 varint downvotes
 *   5 varint modifiedSec · 6 varint notes · 7 varint audio · 8 varint images
 * Returns null for a deck without an id (it could not be downloaded anyway).
 */
function parseDeck(bytes: Uint8Array, start: number, end: number): AnkiWebDeck | null {
  let id = '';
  let name = '';
  let upvotes = 0;
  let downvotes = 0;
  let modifiedSec = 0;
  let notes = 0;
  let audio = 0;
  let images = 0;

  // Clamp the submessage bound to the buffer: a corrupt length must not push
  // `end` past `bytes.length`, or readVarint would pin at the edge and the loop
  // would never advance (an app-freezing hang). `loopStart` is a belt-and-
  // suspenders backstop for any wire type that fails to make progress.
  const stop = Math.min(end, bytes.length);
  let pos = Math.max(0, start);
  while (pos < stop) {
    const loopStart = pos;
    const [tag, afterTag] = readVarint(bytes, pos);
    pos = afterTag;
    const fieldNum = tag >>> 3; // tags are tiny, so the 32-bit shift is safe
    const wireType = tag & 0x7;

    if (wireType === 0) {
      const [val, afterVal] = readVarint(bytes, pos);
      pos = afterVal;
      switch (fieldNum) {
        case 1:
          id = String(val); // < 2^32 ⇒ exact decimal
          break;
        case 3:
          upvotes = val;
          break;
        case 4:
          downvotes = val;
          break;
        case 5:
          modifiedSec = val;
          break;
        case 6:
          notes = val;
          break;
        case 7:
          audio = val;
          break;
        case 8:
          images = val;
          break;
        default:
          break;
      }
    } else if (wireType === 2) {
      const [len, afterLen] = readVarint(bytes, pos);
      pos = afterLen;
      const fieldEnd = Math.min(pos + len, stop);
      if (fieldNum === 2) {
        // UTF-8 name (may contain emoji / accents) — decode the exact slice.
        name = strFromU8(bytes.slice(pos, fieldEnd));
      }
      pos = fieldEnd;
    } else {
      pos = skipField(bytes, pos, wireType);
    }
    if (pos <= loopStart) break; // no progress ⇒ corrupt buffer, bail
  }

  if (id === '') return null;
  return { id, name, notes, upvotes, downvotes, modifiedSec, audio, images };
}

/**
 * Decode a full list-decks response: a top-level message `{ repeated Deck = 1 }`.
 * Every entry is field #1, wire type 2 (a length-delimited Deck submessage);
 * anything else is skipped. Result is sorted by upvotes, highest first.
 * Exported so it can be unit-checked against the golden fixture.
 */
export function parseDecksResponse(bytes: Uint8Array): AnkiWebDeck[] {
  const decks: AnkiWebDeck[] = [];
  let pos = 0;
  while (pos < bytes.length) {
    const loopStart = pos;
    const [tag, afterTag] = readVarint(bytes, pos);
    pos = afterTag;
    const fieldNum = tag >>> 3;
    const wireType = tag & 0x7;

    if (fieldNum === 1 && wireType === 2) {
      const [len, afterLen] = readVarint(bytes, pos);
      pos = afterLen;
      const end = Math.min(pos + len, bytes.length); // never index past the buffer
      const deck = parseDeck(bytes, pos, end);
      if (deck) decks.push(deck);
      pos = end;
    } else {
      pos = skipField(bytes, pos, wireType);
    }
    if (pos <= loopStart) break; // no progress ⇒ corrupt buffer, bail
  }
  decks.sort((a, b) => b.upvotes - a.upvotes);
  return decks;
}

/* -------------------------------------------------------- token extraction */

/** Decode a pure-ASCII byte slice (the token is base64url + "."). */
function asciiDecode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/**
 * Pull the single-use download token out of an item-info response.
 *
 * The token is a length-PREFIXED protobuf string ("eyJ…", a base64url(payload)
 * + "." + base64url(HMAC), 92 chars for a 10-digit `iat`). The byte right after
 * it is the NEXT field's tag and is often itself a valid base64url char, so a
 * greedy scan over-reads and corrupts the signature. Instead:
 *   1. find the ascii "eyJ" (0x65 0x79 0x4A) — the token's start `p`;
 *   2. the byte at p-1 is the length prefix (a one-byte varint, < 128);
 *   3. slice exactly that many bytes from p and ASCII-decode them;
 *   4. accept only if the signature segment (split('.')[1]) is 43 chars — the
 *      tell-tale that we sliced the right length (a greedy capture gives 44).
 * Returns null when no valid token is present.
 */
export function extractDownloadToken(bytes: Uint8Array): string | null {
  for (let p = 0; p + 2 < bytes.length; p++) {
    if (bytes[p] !== 0x65 || bytes[p + 1] !== 0x79 || bytes[p + 2] !== 0x4a) continue;
    if (p === 0) continue; // no room for a length-prefix byte before it

    const len = bytes[p - 1]; // one-byte varint length (token is < 128 bytes)
    if (len >= 0x80) continue; // multi-byte varint ⇒ not our length prefix
    const end = p + len;
    if (end > bytes.length) continue; // would run past the buffer

    const token = asciiDecode(bytes.slice(p, end));
    const parts = token.split('.');
    // HMAC-SHA256 (32 bytes) → 43 base64url chars, no padding. Exactly this
    // length proves we did not over-read the next field's tag byte.
    if (parts.length >= 2 && parts[1].length === 43) return token;
    // otherwise keep scanning for another "eyJ" candidate
  }
  return null;
}

/* ---------------------------------------------------------------- helpers */

/**
 * True for an aborted fetch. RN may reject with a DOMException or a plain Error,
 * either way `name === 'AbortError'`; we re-throw these untouched so callers can
 * tell cancellation apart from a real failure.
 */
function isAbortError(err: unknown): boolean {
  if (err instanceof Error) return err.name === 'AbortError';
  if (typeof err === 'object' && err !== null) {
    return (err as { name?: unknown }).name === 'AbortError';
  }
  return false;
}

/** GET a URL and return its body as raw bytes; maps failures to AnkiWebError. */
async function fetchBytes(
  url: string,
  httpCode: AnkiWebErrorCode,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (err) {
    if (isAbortError(err)) throw err; // propagate cancellation as-is
    throw new AnkiWebError('network', 'Could not reach AnkiWeb. Check your connection.');
  }
  if (!res.ok) {
    throw new AnkiWebError(httpCode, `AnkiWeb returned HTTP ${res.status}.`);
  }
  // Refuse an over-large body before reading it when the server declares one.
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new AnkiWebError(httpCode, 'AnkiWeb response is too large to import safely.');
  }
  try {
    // RN fetch exposes binary via arrayBuffer(); there is no CORS to worry about.
    const buf = await res.arrayBuffer();
    // ...and re-check the actual size, in case Content-Length was absent or lied.
    if (buf.byteLength > MAX_RESPONSE_BYTES) {
      throw new AnkiWebError(httpCode, 'AnkiWeb response is too large to import safely.');
    }
    return new Uint8Array(buf);
  } catch (err) {
    if (err instanceof AnkiWebError) throw err; // don't mask the size guard
    if (isAbortError(err)) throw err;
    throw new AnkiWebError(httpCode, 'AnkiWeb response could not be read.');
  }
}

/* ----------------------------------------------------------- public API */

/**
 * Search shared decks. Returns every match in ONE response (no pagination),
 * sorted by upvotes (highest first). A query with no matches resolves to [].
 * Re-throws AbortError untouched; wraps everything else in AnkiWebError.
 */
export async function searchSharedDecks(
  query: string,
  signal?: AbortSignal,
): Promise<AnkiWebDeck[]> {
  const url = `${BASE}/svc/shared/list-decks?search=${encodeURIComponent(query)}`;
  const bytes = await fetchBytes(url, 'http', signal);
  return parseDecksResponse(bytes);
}

/**
 * Download a shared deck by id, returning the raw .apkg (a PK zip) bytes for the
 * existing parseApkg() to consume. Two hops: item-info mints a fresh, single-use,
 * time-limited token, then download-deck is called with it IMMEDIATELY (it
 * expires fast). Re-throws AbortError untouched.
 */
export async function downloadSharedDeck(id: string, signal?: AbortSignal): Promise<Uint8Array> {
  // Step 1: mint the token.
  const infoUrl = `${BASE}/svc/shared/item-info?sharedId=${encodeURIComponent(id)}`;
  const infoBytes = await fetchBytes(infoUrl, 'http', signal);
  const token = extractDownloadToken(infoBytes);
  if (!token) {
    throw new AnkiWebError('token', 'AnkiWeb did not return a valid download token.');
  }

  // Step 2: spend the token right away.
  const dlUrl = `${BASE}/svc/shared/download-deck/${encodeURIComponent(id)}?t=${encodeURIComponent(token)}`;
  return fetchBytes(dlUrl, 'download', signal);
}

/**
 * Coerce user input into a shared-deck id, or null. Accepts a bare numeric id
 * (>= 6 digits) or any ankiweb.net URL containing /shared/info/<id>,
 * /shared/decks/<id>, or /shared/download/<id>. Query string and fragment are
 * ignored so they cannot smuggle in stray digits.
 */
export function parseAnkiWebId(input: string): string | null {
  const raw = (input ?? '').trim();
  if (raw === '') return null;

  // Drop #fragment then ?query before looking for digits.
  const noFragment = raw.split('#')[0];
  const noQuery = noFragment.split('?')[0];

  // Bare id — long enough that a stray small number can't masquerade as one.
  if (/^\d{6,}$/.test(noQuery)) return noQuery;

  // A shared-deck URL in any of the three known path shapes.
  const m = noQuery.match(/\/shared\/(?:info|decks|download)\/(\d+)/);
  if (m) return m[1];

  return null;
}
