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

/**
 * Best-effort source language for an import, from hints like the deck/file name.
 * Returns a deck-language DISPLAY name (pairs with langCode/LANG_FLAGS); defaults
 * to 'German' — the app's primary language — when nothing matches. Only the
 * TTS-supported languages are returned so a card's pronunciation matches its
 * text instead of every import being forced to German.
 */
export function inferLang(hints: string[]): string {
  const hay = ' ' + hints.join(' ').toLowerCase() + ' ';
  const has = (...words: string[]) => words.some((w) => hay.includes(w));
  if (has('spanish', 'español', 'espanol', 'castellano', 'spanisch', 'espagnol', 'spagnolo'))
    return 'Spanish';
  if (has('french', 'français', 'francais', 'französisch', 'francés', 'frances', 'francese'))
    return 'French';
  return 'German';
}
