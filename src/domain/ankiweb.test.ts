/**
 * AnkiWeb protobuf decoding. The load-bearing test is TERMINATION: a malformed
 * length prefix used to make parseDeck's `while (pos < end)` spin forever and
 * freeze the app (H4). These tests would TIME OUT (not just fail) if the hang
 * regressed — they prove the parser always returns.
 */
import { afterEach, describe, expect, test } from '@jest/globals';

import { parseAnkiWebId, parseDecksResponse, searchSharedDecks } from './ankiweb';

/* --- tiny protobuf encoders (mirror the hand-rolled reader under test) --- */
function varint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return out;
}
const ascii = (s: string): number[] => Array.from(s, (ch) => ch.charCodeAt(0));

const f1Id = (id: number) => [0x08, ...varint(id)]; // field 1, varint
const f2Name = (s: string) => [0x12, ...varint(s.length), ...ascii(s)]; // field 2, string
const f3Upvotes = (n: number) => [0x18, ...varint(n)]; // field 3, varint

const deckSub = (id: number, name: string, upvotes: number) => [
  ...f1Id(id),
  ...f2Name(name),
  ...f3Upvotes(upvotes),
];
/** Wrap deck submessages as the top-level repeated field 1 (wire type 2). */
function listResponse(subs: number[][]): Uint8Array {
  const out: number[] = [];
  for (const s of subs) out.push(0x0a, ...varint(s.length), ...s);
  return new Uint8Array(out);
}

describe('parseDecksResponse — well-formed', () => {
  test('decodes every deck and sorts by upvotes, highest first', () => {
    const bytes = listResponse([
      deckSub(123456, 'German A1', 5),
      deckSub(234567, 'Spanish Basics', 99),
    ]);
    const decks = parseDecksResponse(bytes);
    expect(decks.map((d) => d.name)).toEqual(['Spanish Basics', 'German A1']);
    expect(decks[0]).toMatchObject({ id: '234567', upvotes: 99 });
  });

  test('an empty buffer yields no decks', () => {
    expect(parseDecksResponse(new Uint8Array(0))).toEqual([]);
  });
});

describe('parseDecksResponse — TERMINATES on a corrupt buffer (H4)', () => {
  test('a top-level length prefix that overruns the buffer does not hang', () => {
    // Claim a 255-byte deck submessage, then supply only a few bytes.
    const bytes = new Uint8Array([0x0a, ...varint(255), ...f1Id(123456)]);
    const decks = parseDecksResponse(bytes); // must RETURN, not spin forever
    expect(Array.isArray(decks)).toBe(true);
  });

  test('a deck string field whose length overruns the buffer does not hang', () => {
    // A deck whose name field claims 200 bytes but the buffer ends early.
    const sub = [...f1Id(123456), 0x12, ...varint(200), ...ascii('clip')];
    const bytes = listResponse([sub]);
    const decks = parseDecksResponse(bytes); // clamped slice, then terminates
    expect(decks).toHaveLength(1);
    expect(decks[0].id).toBe('123456');
  });

  test('trailing garbage after a valid deck is tolerated', () => {
    const good = listResponse([deckSub(123456, 'Ok', 1)]);
    const bytes = new Uint8Array([...good, 0xff, 0xff, 0xff]);
    expect(() => parseDecksResponse(bytes)).not.toThrow();
    expect(parseDecksResponse(bytes)[0].id).toBe('123456');
  });
});

describe('fetchBytes — refuses an over-large response (L18)', () => {
  const origFetch = global.fetch;
  afterEach(() => {
    global.fetch = origFetch;
  });

  // Duck-typed Response: arrayBuffer returns just a { byteLength } so the size
  // guard can fire without allocating tens of MB in the test.
  const fakeResponse = (contentLength: string | null, byteLength: number): Response =>
    ({
      ok: true,
      status: 200,
      headers: { get: (h: string) => (h.toLowerCase() === 'content-length' ? contentLength : null) },
      arrayBuffer: async () => ({ byteLength }) as ArrayBuffer,
    }) as unknown as Response;

  const TOO_BIG = 200 * 1024 * 1024; // > the 64 MB cap

  test('rejects when the declared Content-Length exceeds the cap', async () => {
    global.fetch = (async () => fakeResponse(String(TOO_BIG), 8)) as typeof fetch;
    await expect(searchSharedDecks('german')).rejects.toThrow(/too large/i);
  });

  test('rejects an over-large body even when Content-Length is absent or lies', async () => {
    // Header says small (or nothing) but the body is huge — the post-read guard.
    global.fetch = (async () => fakeResponse(null, TOO_BIG)) as typeof fetch;
    await expect(searchSharedDecks('german')).rejects.toThrow(/too large/i);
  });
});

describe('parseAnkiWebId', () => {
  test('accepts a bare long numeric id', () => {
    expect(parseAnkiWebId('123456')).toBe('123456');
  });
  test('extracts the id from a shared-deck URL, ignoring query/fragment', () => {
    expect(parseAnkiWebId('https://ankiweb.net/shared/info/987654321?foo=1#x')).toBe('987654321');
  });
  test('rejects junk and too-short ids', () => {
    expect(parseAnkiWebId('hello')).toBeNull();
    expect(parseAnkiWebId('123')).toBeNull();
  });
});
