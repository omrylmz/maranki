/**
 * TTS pronunciation — wires the design's audio play buttons (session card,
 * card peek "Say it") to the platform speech engine.
 */
import * as Speech from 'expo-speech';

export function speak(text: string): void {
  Speech.stop();
  Speech.speak(text, { rate: 0.95 });
}
