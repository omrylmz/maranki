/**
 * Read aloud — text to speech with the field's language (spec §6.8).
 *
 *   speak('die Stunde', 'de-DE');   // a German voice says the word
 *   speak('the hour');              // no language: the phone's own voice
 *
 * Which text and which language: the 🔊 button speaks the HEADLINE block of
 * the side you see. Screens get both from `speechOf(face, side)`
 * (src/domain/face.ts): the block's `plain` text and its resolved `lang`
 * (render.ts `resolveFieldLang`: FieldDef.lang → the deck's language for
 * card types made in the app → none).
 *
 * `speak` passes `{ language, rate: 0.95 }` to expo-speech.
 * `SpeechOptions.language` is a BCP-47 tag ('de-DE'), as our field
 * languages are (checked in the SDK 56 docs). It stops what is being said
 * first, so a fast tap on the next card never queues two words.
 *
 * A phone may have NO voice for a language. The OS then reads the text
 * with another voice (often badly), so we still speak, and the screen shows
 * a short note ONCE per language per app run:
 *
 *   missingVoiceNotice('de-DE') → 'No German voice on this phone. You can add one in system settings.'
 *   missingVoiceNotice('de-DE') → null   (already shown)
 *
 * Android loads its voices a moment after the app starts, so an EMPTY voice
 * list says nothing (we cannot tell yet): no note, and the language is not
 * marked as shown, so the next call can still decide.
 *
 * The pure parts (`hasVoiceFor`, `missingVoiceMessage`, `speechOptions`) are
 * tested; the expo-speech calls are thin.
 */
import * as Speech from 'expo-speech';

import { langLabel, primary } from './lang';

/** The speaking speed: a little slower than normal, for learners. */
export const SPEECH_RATE = 0.95;

/** The options for expo-speech: the language only when we know it. */
export function speechOptions(lang?: string | null): Speech.SpeechOptions {
  const clean = typeof lang === 'string' ? lang.trim() : '';
  return clean ? { language: clean, rate: SPEECH_RATE } : { rate: SPEECH_RATE };
}

/** Say `text` aloud, in the voice of `lang` (BCP-47) when given. Empty text says nothing. */
export function speak(text: string, lang?: string): void {
  if (typeof text !== 'string' || text.trim() === '') return;
  try {
    void Speech.stop();
    Speech.speak(text, speechOptions(lang));
  } catch {
    // No speech engine (an old dev build, the web preview): read-aloud is a help, never an error.
  }
}

/** Stop speaking (for example when the study session closes). */
export function stopSpeaking(): void {
  try {
    void Speech.stop();
  } catch {
    // Nothing is speaking, or there is no speech engine.
  }
}

/**
 * The language part of a voice's tag. Android may give ISO 639-2 codes
 * ('deu-DEU'), iOS gives 'de-DE'; both become 'de'.
 */
function voicePrimary(tag: string): string {
  return primary(tag) || primary((tag ?? '').split(/[-_]/)[0]);
}

/**
 * True when one of `voices` speaks the language of `lang` (the language
 * part only: an Austrian 'de-AT' voice can read 'de-DE').
 *
 *   hasVoiceFor([{ language: 'de-DE' }], 'de-AT') → true
 *   hasVoiceFor([{ language: 'en-US' }], 'de-DE') → false
 */
export function hasVoiceFor(voices: readonly { language: string }[], lang: string): boolean {
  const want = primary(lang);
  if (!want) return true;
  return voices.some((v) => typeof v?.language === 'string' && voicePrimary(v.language) === want);
}

/** The note when the phone has no voice for `lang` (spec §6.8, exact copy). */
export function missingVoiceMessage(lang: string): string {
  return `No ${langLabel(lang)} voice on this phone. You can add one in system settings.`;
}

/** The languages whose note was shown (or that have a voice) in this app run. */
const decided = new Set<string>();

/**
 * The "no voice" note for `lang`, the FIRST time a language has no voice in
 * this app run; null otherwise (a voice exists, the note was shown, no
 * language, or the voices are not known yet). Never rejects.
 */
export async function missingVoiceNotice(lang?: string | null): Promise<string | null> {
  const key = primary(lang);
  if (!lang || !key || decided.has(key)) return null;
  let voices: Speech.Voice[];
  try {
    voices = await Speech.getAvailableVoicesAsync();
  } catch {
    return null;
  }
  if (!Array.isArray(voices) || voices.length === 0) return null; // not loaded yet: decide later
  if (decided.has(key)) return null; // another call decided while we waited
  decided.add(key);
  return hasVoiceFor(voices, lang) ? null : missingVoiceMessage(lang);
}

/** Tests only: forget which languages were decided. */
export function resetVoiceNoticesForTests(): void {
  decided.clear();
}
