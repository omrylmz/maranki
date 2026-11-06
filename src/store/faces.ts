/**
 * useFaces() — how every screen gets a card's text (the read seam, spec §6.2,
 * units W1-5 and W3-4).
 *
 *   const faceOf = useFaces();
 *   const face = faceOf(card);
 *   <Text>{face.promptPlain}</Text>
 *
 * A screen never reads card text itself (a guard test in
 * src/domain/face.test.ts fails if it does). From wave 3 the text lives in
 * the NOTES, so this hook reads the notes, the card types and the decks from
 * the store and returns `facesFor(index, decks)` (src/domain/face.ts): for a
 * card it calls `renderFace(note, type, card.ord, deck)`.
 *
 * Caching, so the hook is cheap and safe in render:
 *   - the library index is built once per (notes, card types) arrays
 *     (scope.ts libraryIndexOf). A rating changes only `cards`, so a rating
 *     never rebuilds it;
 *   - the returned function is the SAME object while the notes, card types
 *     and decks stay the same (safe in useMemo dependency lists);
 *   - each face is cached per note object (renderFace's WeakMap), and the
 *     two directions of one note share their blocks.
 *
 * A card whose note is missing (damaged data) still draws: it falls back to
 * its own text (legacyFace), which is empty for a v3 card — never a crash.
 */
import { type FaceOf, facesFor } from '../domain/face';
import type { DataStateV3 } from '../domain/model';
import { decksById, libraryIndexOf } from '../domain/scope';
import { useStateV3 } from './selectors';

export type { FaceOf } from '../domain/face';

/** The card → face function of a state. The same notes, card types and decks give the same function. */
export function faceFnOf(state: Pick<DataStateV3, 'notes' | 'noteTypes' | 'decks'>): FaceOf {
  return facesFor(libraryIndexOf(state), decksById(state.decks));
}

/** The card → face function for the current data. Call it at the top of a component. */
export function useFaces(): FaceOf {
  return useStateV3(faceFnOf);
}
