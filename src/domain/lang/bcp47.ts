/**
 * Language tags (spec §9.2, `bcp47.ts`). A BCP-47 tag names a language and,
 * optionally, a script and a region: 'de-DE' (German, Germany), 'en-GB'
 * (English, United Kingdom), 'zh-Hant-TW' (Chinese, traditional script, Taiwan).
 * Read-aloud (`expo-speech` `SpeechOptions.language`) and the language pickers
 * use these tags.
 *
 *   normalizeLang('de_DE')  → 'de-DE'   (Anki writes {{tts de_DE:Word}})
 *   normalizeLang('de')     → 'de-DE'   (a bare language gets its usual region)
 *   normalizeLang('German') → 'de-DE'   (an English or native language name)
 *   primary('de-DE')        → 'de'
 *   langLabel('de-DE')      → 'German'
 *   langLabel('en-GB')      → 'English (UK)'
 *
 * Pure: no React, no I/O. Hermes-safe: no `Intl`, no `localeCompare`,
 * no `String.prototype.normalize` (name matching uses `foldText`).
 */
import { foldText } from '../text';

/** One known language: its code, its usual region, its English name and other names. */
interface LangInfo {
  /** ISO 639-1 code, lower case: 'de'. */
  code: string;
  /** The region a bare code gets: 'de' → 'de-DE'. */
  region: string;
  /** English name, shown in the UI: 'German'. */
  name: string;
  /** Other names and ISO 639-2 codes, FOLDED (lower case, no accents): 'deutsch', 'ger', 'deu'. */
  aliases: string[];
}

/**
 * The languages the helpers know by name. Any other well-formed tag still
 * works (it is kept as it is); it just has no English name.
 */
const LANGS: readonly LangInfo[] = [
  { code: 'en', region: 'US', name: 'English', aliases: ['englisch', 'ingles', 'anglais', 'inglese', 'eng'] },
  { code: 'de', region: 'DE', name: 'German', aliases: ['deutsch', 'aleman', 'allemand', 'tedesco', 'ger', 'deu'] },
  { code: 'es', region: 'ES', name: 'Spanish', aliases: ['espanol', 'castellano', 'spanisch', 'espagnol', 'spa'] },
  { code: 'fr', region: 'FR', name: 'French', aliases: ['francais', 'franzosisch', 'frances', 'fra', 'fre'] },
  { code: 'it', region: 'IT', name: 'Italian', aliases: ['italiano', 'italienisch', 'italien', 'ita'] },
  { code: 'pt', region: 'BR', name: 'Portuguese', aliases: ['portugues', 'portugiesisch', 'por'] },
  { code: 'nl', region: 'NL', name: 'Dutch', aliases: ['nederlands', 'niederlandisch', 'nld', 'dut'] },
  { code: 'sv', region: 'SE', name: 'Swedish', aliases: ['svenska', 'schwedisch', 'swe'] },
  { code: 'da', region: 'DK', name: 'Danish', aliases: ['dansk', 'danisch', 'dan'] },
  { code: 'nb', region: 'NO', name: 'Norwegian', aliases: ['norsk', 'bokmal', 'norwegisch', 'nor', 'nob'] },
  { code: 'fi', region: 'FI', name: 'Finnish', aliases: ['suomi', 'finnisch', 'fin'] },
  { code: 'is', region: 'IS', name: 'Icelandic', aliases: ['islenska', 'isl', 'ice'] },
  { code: 'pl', region: 'PL', name: 'Polish', aliases: ['polski', 'polnisch', 'pol'] },
  { code: 'cs', region: 'CZ', name: 'Czech', aliases: ['cestina', 'tschechisch', 'ces', 'cze'] },
  { code: 'sk', region: 'SK', name: 'Slovak', aliases: ['slovencina', 'slk', 'slo'] },
  { code: 'sl', region: 'SI', name: 'Slovenian', aliases: ['slovenscina', 'slv'] },
  { code: 'hr', region: 'HR', name: 'Croatian', aliases: ['hrvatski', 'hrv'] },
  { code: 'sr', region: 'RS', name: 'Serbian', aliases: ['srpski', 'srp'] },
  { code: 'bg', region: 'BG', name: 'Bulgarian', aliases: ['bul'] },
  { code: 'hu', region: 'HU', name: 'Hungarian', aliases: ['magyar', 'ungarisch', 'hun'] },
  { code: 'ro', region: 'RO', name: 'Romanian', aliases: ['romana', 'rumanisch', 'ron', 'rum'] },
  { code: 'el', region: 'GR', name: 'Greek', aliases: ['griechisch', 'ell', 'gre'] },
  { code: 'tr', region: 'TR', name: 'Turkish', aliases: ['turkce', 'turkisch', 'tur'] },
  { code: 'ru', region: 'RU', name: 'Russian', aliases: ['russisch', 'rus'] },
  { code: 'uk', region: 'UA', name: 'Ukrainian', aliases: ['ukrainisch', 'ukr'] },
  { code: 'ar', region: 'SA', name: 'Arabic', aliases: ['arabisch', 'ara'] },
  { code: 'he', region: 'IL', name: 'Hebrew', aliases: ['hebraisch', 'heb'] },
  { code: 'fa', region: 'IR', name: 'Persian', aliases: ['farsi', 'fas', 'per'] },
  { code: 'hi', region: 'IN', name: 'Hindi', aliases: ['hin'] },
  { code: 'bn', region: 'BD', name: 'Bengali', aliases: ['bangla', 'ben'] },
  { code: 'id', region: 'ID', name: 'Indonesian', aliases: ['bahasa indonesia', 'ind'] },
  { code: 'ms', region: 'MY', name: 'Malay', aliases: ['bahasa melayu', 'msa', 'may'] },
  { code: 'vi', region: 'VN', name: 'Vietnamese', aliases: ['tieng viet', 'vie'] },
  { code: 'th', region: 'TH', name: 'Thai', aliases: ['tha'] },
  { code: 'ja', region: 'JP', name: 'Japanese', aliases: ['nihongo', 'japanisch', 'jpn'] },
  { code: 'ko', region: 'KR', name: 'Korean', aliases: ['hangugeo', 'koreanisch', 'kor'] },
  { code: 'zh', region: 'CN', name: 'Chinese', aliases: ['mandarin', 'zhongwen', 'chinesisch', 'zho', 'chi'] },
  { code: 'ca', region: 'ES', name: 'Catalan', aliases: ['catala', 'cat'] },
  { code: 'eu', region: 'ES', name: 'Basque', aliases: ['euskara', 'eus', 'baq'] },
  { code: 'gl', region: 'ES', name: 'Galician', aliases: ['galego', 'glg'] },
  { code: 'cy', region: 'GB', name: 'Welsh', aliases: ['cymraeg', 'cym', 'wel'] },
  { code: 'ga', region: 'IE', name: 'Irish', aliases: ['gaeilge', 'gle'] },
];

/** Old or other codes that mean a code above: 'iw' (old Hebrew) → 'he', 'no' → 'nb'. */
const CODE_ALIASES: Record<string, string> = { iw: 'he', in: 'id', ji: 'yi', no: 'nb' };

/** Region names for labels. A region not listed shows its code: 'English (NZ)'. */
const REGION_NAMES: Record<string, string> = {
  US: 'US',
  GB: 'UK',
  AU: 'Australia',
  CA: 'Canada',
  IE: 'Ireland',
  IN: 'India',
  ZA: 'South Africa',
  ES: 'Spain',
  MX: 'Mexico',
  AR: 'Argentina',
  CO: 'Colombia',
  CL: 'Chile',
  BR: 'Brazil',
  PT: 'Portugal',
  FR: 'France',
  BE: 'Belgium',
  CH: 'Switzerland',
  DE: 'Germany',
  AT: 'Austria',
  IT: 'Italy',
  NL: 'Netherlands',
  CN: 'China',
  TW: 'Taiwan',
  HK: 'Hong Kong',
  SG: 'Singapore',
};

/** Script names for labels: 'zh-Hant' → 'Chinese (Traditional)'. */
const SCRIPT_NAMES: Record<string, string> = {
  Hans: 'Simplified',
  Hant: 'Traditional',
  Latn: 'Latin',
  Cyrl: 'Cyrillic',
};

/* ------------------------------------------------------------ lookups */

const BY_CODE = new Map<string, LangInfo>();
/** Folded name or alias → language: 'german', 'deutsch', 'deu' → de. */
const BY_NAME = new Map<string, LangInfo>();
for (const lang of LANGS) {
  BY_CODE.set(lang.code, lang);
  BY_NAME.set(foldText(lang.name), lang);
  for (const alias of lang.aliases) BY_NAME.set(alias, lang);
}
/** Folded region name → region code: 'uk' → 'GB', 'brazil' → 'BR'. */
const REGION_BY_NAME = new Map<string, string>();
for (const [code, name] of Object.entries(REGION_NAMES)) {
  REGION_BY_NAME.set(foldText(name), code);
  REGION_BY_NAME.set(code.toLowerCase(), code);
}

/** A BCP-47-like tag: a 2–3 letter language, then subtags joined by '-' or '_'. */
const TAG_SHAPE = /^[a-z]{2,3}(?:[-_][a-z0-9]{1,8})*$/i;

/** "German (Germany)" → name "German", region "Germany". */
const NAME_WITH_REGION = /^(.+?)\s*\(\s*([^()]+?)\s*\)$/;

/**
 * Tidy the subtags of a tag: language lower case, script Title case
 * (4 letters), region upper case (2 letters or 3 digits), anything else lower case.
 */
function tidyTag(parts: string[]): string {
  return parts
    .map((part, k) => {
      if (k === 0) return part.toLowerCase();
      if (part.length === 4 && /^[a-z]+$/i.test(part)) {
        return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
      }
      if (/^[a-z]{2}$/i.test(part) || /^\d{3}$/.test(part)) return part.toUpperCase();
      return part.toLowerCase();
    })
    .join('-');
}

/** A known language's default tag: de → 'de-DE'. */
function defaultTag(lang: LangInfo): string {
  return `${lang.code}-${lang.region}`;
}

/* ------------------------------------------------------------- the API */

/**
 * Any way of writing a language → a clean BCP-47 tag, or null when it is not
 * a language we can read.
 *
 *   'de_DE' → 'de-DE'      'DE-de' → 'de-DE'      'en_us' → 'en-US'
 *   'de'    → 'de-DE'      'deu'   → 'de-DE'      'no'    → 'nb-NO'
 *   'German' / 'german' / 'Deutsch' → 'de-DE'
 *   'English (UK)' → 'en-GB'
 *   'zh-hant-tw' → 'zh-Hant-TW'   (script and region keep their case rules)
 *   'xx-YY' → 'xx-YY'             (well-formed but unknown: kept)
 *   'Klingon', '' → null
 */
export function normalizeLang(input: string | null | undefined): string | null {
  const s = (input ?? '').trim();
  if (s === '') return null;

  if (TAG_SHAPE.test(s)) {
    const parts = s.split(/[-_]/);
    const first = parts[0].toLowerCase();
    const code = CODE_ALIASES[first] ?? first;
    // A 3-letter code that is an ISO 639-2 alias ('deu') → its 2-letter code.
    const known = BY_CODE.get(code) ?? (code.length === 3 ? BY_NAME.get(code) : undefined);
    if (parts.length === 1) return known ? defaultTag(known) : code;
    return tidyTag([known ? known.code : code, ...parts.slice(1)]);
  }

  // A language name, maybe with a region: 'German', 'English (UK)'.
  const withRegion = NAME_WITH_REGION.exec(s);
  const namePart = withRegion ? withRegion[1] : s;
  const lang = BY_NAME.get(foldText(namePart).replace(/\s+/g, ' '));
  if (!lang) return null;
  if (withRegion) {
    const region = REGION_BY_NAME.get(foldText(withRegion[2]));
    if (region) return `${lang.code}-${region}`;
  }
  return defaultTag(lang);
}

/**
 * The language part of a tag, lower case: 'de-DE' → 'de'. Accepts anything
 * normalizeLang accepts ('German' → 'de'). '' when there is no language.
 */
export function primary(tag: string | null | undefined): string {
  const clean = normalizeLang(tag);
  return clean ? clean.split('-')[0] : '';
}

/**
 * A short English label for a tag, for pickers and direction names.
 * The usual region of a language is not repeated; another region is added
 * in brackets.
 *
 *   'de-DE' → 'German'           'en-US' → 'English'
 *   'en-GB' → 'English (UK)'     'pt-PT' → 'Portuguese (Portugal)'
 *   'zh-Hant-TW' → 'Chinese (Traditional, Taiwan)'
 *   'xx-YY' → 'xx-YY'            (unknown language: the tag itself)
 */
export function langLabel(tag: string | null | undefined): string {
  const clean = normalizeLang(tag);
  if (!clean) return (tag ?? '').trim();
  const [code, ...rest] = clean.split('-');
  const lang = BY_CODE.get(code);
  if (!lang) return clean;

  const extras: string[] = [];
  for (const part of rest) {
    if (part.length === 4) extras.push(SCRIPT_NAMES[part] ?? part);
    else if (part !== lang.region) extras.push(REGION_NAMES[part] ?? part);
  }
  return extras.length > 0 ? `${lang.name} (${extras.join(', ')})` : lang.name;
}

/**
 * The static list for language pickers. At runtime the picker merges it
 * with the languages of the phone's voices (`mergeLangs`).
 */
export const COMMON_LANGS: readonly string[] = Object.freeze([
  'en-US',
  'en-GB',
  'de-DE',
  'es-ES',
  'es-MX',
  'fr-FR',
  'it-IT',
  'pt-BR',
  'pt-PT',
  'nl-NL',
  'sv-SE',
  'da-DK',
  'nb-NO',
  'fi-FI',
  'pl-PL',
  'cs-CZ',
  'hu-HU',
  'ro-RO',
  'el-GR',
  'tr-TR',
  'ru-RU',
  'uk-UA',
  'ar-SA',
  'he-IL',
  'hi-IN',
  'id-ID',
  'vi-VN',
  'th-TH',
  'ja-JP',
  'ko-KR',
  'zh-CN',
  'zh-TW',
]);

/**
 * Several tag lists → one clean list: every tag normalized, no duplicates,
 * sorted by label (then by tag). Tags that are not languages are left out.
 *
 *   mergeLangs(COMMON_LANGS, voices.map((v) => v.language))
 */
export function mergeLangs(...lists: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>();
  for (const list of lists) {
    for (const tag of list) {
      const clean = normalizeLang(tag);
      if (clean) seen.add(clean);
    }
  }
  const rows = Array.from(seen, (tag) => ({ tag, label: langLabel(tag) }));
  // Plain comparator: Hermes has no reliable localeCompare.
  rows.sort((a, b) =>
    a.label < b.label ? -1 : a.label > b.label ? 1 : a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0,
  );
  return rows.map((r) => r.tag);
}
