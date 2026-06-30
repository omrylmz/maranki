/**
 * Word-shape helpers shared by the seed corpus and the card editor.
 */
import { Lang } from './types';

const ARTICLES = ['der', 'die', 'das', 'el', 'la', 'los', 'las', 'le', 'les', 'un', 'une'];

/** "die Stunde" → { article: "die", base: "Stunde" }; "verstehen" → no article. */
export function splitArticle(word: string): { article: string | null; base: string } {
  const sp = word.indexOf(' ');
  if (sp > 0) {
    const head = word.slice(0, sp).toLowerCase();
    if (ARTICLES.includes(head)) return { article: word.slice(0, sp), base: word.slice(sp + 1) };
  }
  return { article: null, base: word };
}

export const LANG_FLAGS: Record<string, string> = {
  German: '🇩🇪',
  Spanish: '🇪🇸',
  French: '🇫🇷',
  Italian: '🇮🇹',
  Other: '📚',
};

export function langCode(langName: string): Lang {
  if (langName === 'Spanish') return 'es';
  if (langName === 'French') return 'fr';
  return 'de';
}

/** Fold the common Latin diacritics so accented labels match (Hermes-safe). */
function foldDiacritics(s: string): string {
  return s
    .replace(/[àáâãäåā]/g, 'a')
    .replace(/[èéêëē]/g, 'e')
    .replace(/[ìíîïī]/g, 'i')
    .replace(/[òóôõöō]/g, 'o')
    .replace(/[ùúûüū]/g, 'u')
    .replace(/ñ/g, 'n')
    .replace(/ç/g, 'c')
    .replace(/ß/g, 'ss');
}

/**
 * Distinctive field/header LABELS that betray a deck's language — used when the
 * deck/file NAME carries no language word but the column headers (CSV) or Anki
 * model field names do (e.g. "Palabra"/"Traducción", "Mot"/"Traduction"). Keys
 * are ascii-folded and matched as WHOLE tokens, because some ("mot") are short
 * enough to appear inside unrelated words where a substring test would misfire.
 */
const FIELD_LANG_LABELS: Record<string, string> = {
  // Spanish
  palabra: 'Spanish',
  traduccion: 'Spanish',
  significado: 'Spanish',
  ejemplo: 'Spanish',
  oracion: 'Spanish',
  respuesta: 'Spanish',
  // French
  mot: 'French',
  traduction: 'French',
  signification: 'French',
  exemple: 'French',
  reponse: 'French',
  // German
  wort: 'German',
  ubersetzung: 'German',
  bedeutung: 'German',
  beispiel: 'German',
  ruckseite: 'German',
  vorderseite: 'German',
};

/**
 * Best-effort source language for an import, from hints like the deck/file name
 * AND (when present) the column headers / Anki field names. Returns a deck-
 * language DISPLAY name (pairs with langCode/LANG_FLAGS); defaults to 'German' —
 * the app's primary language — when nothing matches. Only the TTS-supported
 * languages are returned so a card's pronunciation matches its text instead of
 * every import being forced to German (H6).
 */
export function inferLang(hints: string[]): string {
  const hay = ' ' + hints.join(' ').toLowerCase() + ' ';
  const has = (...words: string[]) => words.some((w) => hay.includes(w));
  // Strongest signal: an explicit language NAME (deck/file name or a field).
  if (has('spanish', 'español', 'espanol', 'castellano', 'spanisch', 'espagnol', 'spagnolo'))
    return 'Spanish';
  if (has('french', 'français', 'francais', 'französisch', 'francés', 'frances', 'francese'))
    return 'French';
  // Next: a distinctive foreign field/header label, matched as a whole token.
  for (const token of foldDiacritics(hints.join(' ').toLowerCase()).split(/[^a-z]+/)) {
    const lang = FIELD_LANG_LABELS[token];
    if (lang) return lang;
  }
  return 'German';
}
