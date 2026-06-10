/**
 * TTS pronunciation — wires the design's audio play buttons (session card,
 * card peek "Say it") to the platform speech engine.
 */
import * as Speech from 'expo-speech';

import { Lang } from './types';

const LOCALE: Record<Lang, string> = {
  de: 'de-DE',
  es: 'es-ES',
  fr: 'fr-FR',
};

export function speakWord(text: string, lang: Lang): void {
  Speech.stop();
  Speech.speak(text, { language: LOCALE[lang] ?? 'en-US', rate: 0.92 });
}
