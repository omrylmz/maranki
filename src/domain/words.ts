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
