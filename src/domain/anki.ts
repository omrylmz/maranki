/**
 * Small pure helpers for Anki data (spec §5.1). Side-effect-free and
 * unit-testable.
 *
 * Until wave 3 this file also mapped an Anki note to ONE flat v2 card
 * (`mapAnkiNote`: front / back / one example / tags). That mapping threw data
 * away (reverse cards, every other field, the guid, the progress), so it is
 * gone (unit W3-5). The lossless import is now:
 *   import/apkgRead.ts  .apkg bytes → AnkiCollection (every field, card and template)
 *   roles.ts            the field roles (suggestMapping)
 *   import/plan.ts      AnkiCollection + the learner's choices → ImportPlan
 *
 * What stays here (the helpers):
 *   - FIELD_SEP     the separator inside Anki's `notes.flds`;
 *   - stripHtml     Anki field HTML → readable plain text (roles.ts,
 *                   htmlLines.ts and the planner use it);
 *   - ankiDeckName  a friendly deck name from several subdeck names.
 *
 * Cloze markup ({{c1::…}}) is NOT read here. src/domain/cloze.ts is the ONE
 * cloze parser of the app; a caller whose text may hold deletions calls
 * `unwrapCloze` (cloze.ts) first, as the planner does. (This file cannot
 * import cloze.ts: cloze.ts → htmlLines.ts → this file would be an import
 * cycle, and Metro warns about every cycle in development.)
 *
 * Hermes-safe: no String.normalize / replaceAll / lookbehind.
 */

/** Unit Separator that joins Anki field values inside `notes.flds`. */
export const FIELD_SEP = '\x1f';

/* ------------------------------------------------------------ deck names */

/**
 * A friendly deck name from the collection's deck names — the longest common
 * "::" prefix of the non-Default decks (e.g. "German::Vocabulary::A1" + "…::B1"
 * → "German Vocabulary"). Falls back to `fallback` (usually the file name).
 */
export function ankiDeckName(deckNames: string[], fallback: string): string {
  const real = deckNames.filter((n) => n && n.trim().toLowerCase() !== 'default');
  if (real.length === 0) return fallback;
  const split = real.map((n) => {
    const parts = n.split('::').map((s) => s.trim());
    // "Default::Sub" → "Sub": don't leak Anki's default container into the name.
    if (parts.length > 1 && parts[0].toLowerCase() === 'default') parts.shift();
    return parts;
  });
  const first = split[0];
  const common: string[] = [];
  for (let i = 0; i < first.length; i++) {
    const seg = first[i];
    if (seg && split.every((parts) => parts[i] === seg)) common.push(seg);
    else break;
  }
  const name = (common.length ? common : first).join(' ').replace(/\s+/g, ' ').trim();
  return name.length ? name : fallback;
}

/* ----------------------------------------------------------------- HTML strip */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  auml: 'ä',
  ouml: 'ö',
  uuml: 'ü',
  Auml: 'Ä',
  Ouml: 'Ö',
  Uuml: 'Ü',
  szlig: 'ß',
  eacute: 'é',
  egrave: 'è',
  agrave: 'à',
  ntilde: 'ñ',
  iexcl: '¡',
  iquest: '¿',
  hellip: '…',
  ndash: '–',
  mdash: '—',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, body: string) => {
    if (body.charAt(0) === '#') {
      const hex = body.charAt(1) === 'x' || body.charAt(1) === 'X';
      const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      // Reject 0 / out-of-range / lone surrogates (0xD800–0xDFFF) — keep the raw
      // entity rather than emit an invalid lone UTF-16 surrogate.
      if (
        !Number.isFinite(code) ||
        code <= 0 ||
        code > 0x10ffff ||
        (code >= 0xd800 && code <= 0xdfff)
      ) {
        return m;
      }
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    // Own keys only: an entity name comes from the file, and "&constructor;"
    // must not find Object's built-in function.
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : m;
  });
}

/**
 * Anki field HTML → readable plain text: tags removed, `<br>` and block ends
 * become spaces, entities decoded, white space collapsed. Media tags
 * (`[sound:x]`, `<img>`) leave nothing behind. Cloze markup is left as
 * written (see the file header: call cloze.ts `unwrapCloze` first).
 *
 *   stripHtml('<b>die</b>&nbsp;Stunde<br>the hour') → 'die Stunde the hour'
 *
 * The negated classes EXCLUDE the opening delimiter ([^<>] not [^>], [^\][]
 * not [^\]]) so a run of unmatched openers can't be re-scanned per position —
 * that keeps every pass linear instead of O(n²), which on a pathological field
 * (e.g. code with many '<' and no '>') would otherwise freeze the single JS
 * thread for minutes.
 */
export function stripHtml(input: string): string {
  if (!input) return '';
  let s = input;
  s = s.replace(/<\s*(script|style)\b[^<>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ' '); // drop script/style
  s = s.replace(/\[(?:sound|anki|image|img):[^\][]*\]/gi, ' '); // [sound:foo.mp3] etc.
  s = s.replace(/<\s*br\s*\/?\s*>/gi, ' '); // <br> → space
  s = s.replace(/<\s*\/\s*(?:div|p|tr|li|h[1-6]|td|th)\s*>/gi, ' '); // block ends → space
  s = s.replace(/<[^<>]*>/g, ''); // any remaining tag
  s = decodeEntities(s);
  s = s.replace(/\s+/g, ' ').trim(); // collapse whitespace
  return s;
}
