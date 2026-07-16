/**
 * Shared import type. `ImportCardPayload` is the lingua franca between the
 * parsers (CSV in importFile.ts, .apkg in importApkg.ts / anki.ts) and the
 * store's importDeck(): a card with a required `front` + `back` and every
 * other Card field optional, so SRS scheduling rides along whenever a source
 * actually carries it.
 *
 * (Historic note: this file used to ship hardcoded sample decks + a
 * `sharedDeckFromLink` stub for the import hub. Those are gone now that the
 * AnkiWeb source is real — search + download live in ankiweb.ts, parsing in
 * importApkg.ts.)
 */
import { Card } from './types';

export type ImportCardPayload = Pick<Card, 'front' | 'back'> & Partial<Card>;
