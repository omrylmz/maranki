/**
 * What Android's back button does on the import wizard (spec §5.9, E15).
 * Pure, so it is tested without a screen.
 *
 * The wizard is local state of ONE screen (import.tsx): source → sections →
 * fields → preview. Without this, back closed the whole screen from any
 * stage, and the learner lost the chosen sections, the field mapping and,
 * for AnkiWeb, the downloaded deck. Now back goes ONE stage back, the same
 * way the screen's own buttons go back, and it closes Import only from the
 * first stage (and after the import, on Done):
 *
 *   preview  → fields (or, when the Fields stage was skipped because the
 *              guess was certain, to sections / the source)
 *   fields   → sections (only when the file has more than one), else source
 *   sections → source (the file is let go: nothing was imported)
 *   importing, while Cancel is offered (download, read, plan) → Cancel
 *   importing, while saving → close, like the header's ✕ (the import
 *              finishes; the images are still written after the save)
 *   source, done → close
 *
 * A deck's AnkiWeb details (on the source stage) has its own handler in
 * SourceStage.tsx: back goes to the search results first.
 */

/** The wizard's stages (import.tsx `Stage`). */
export type ImportStage = 'source' | 'sections' | 'fields' | 'preview' | 'importing' | 'done';
/** The steps of the progress view (import.tsx `Phase`). */
export type ImportPhase = 'download' | 'read' | 'plan' | 'save' | 'images';

/** What back does: close the screen, run Cancel, or go to a stage. */
export type ImportBackAction = 'close' | 'cancel' | 'source' | 'sections' | 'fields';

/**
 *   importBackAction({ stage: 'preview', phase: 'plan', sectionCount: 3, fieldsSkipped: false }) → 'fields'
 *   importBackAction({ stage: 'preview', phase: 'plan', sectionCount: 1, fieldsSkipped: true })  → 'source'
 *   importBackAction({ stage: 'source',  phase: 'read', sectionCount: 0, fieldsSkipped: false }) → 'close'
 */
export function importBackAction(input: {
  stage: ImportStage;
  phase: ImportPhase;
  /** How many subdecks the read file has (the Sections stage shows only for more than one). */
  sectionCount: number;
  /** True when the Fields stage was skipped (a certain guess, one line on the Preview). */
  fieldsSkipped: boolean;
}): ImportBackAction {
  const beforeFields: ImportBackAction = input.sectionCount > 1 ? 'sections' : 'source';
  switch (input.stage) {
    case 'sections':
      return 'source';
    case 'fields':
      return beforeFields;
    case 'preview':
      return input.fieldsSkipped ? beforeFields : 'fields';
    case 'importing':
      return input.phase === 'download' || input.phase === 'read' || input.phase === 'plan' ? 'cancel' : 'close';
    case 'source':
    case 'done':
      return 'close';
  }
}
