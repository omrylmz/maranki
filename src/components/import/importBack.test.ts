/**
 * Android's back on the import wizard (importBack.ts): one stage back, and
 * Import closes only from the first stage (and after the import).
 */
import { describe, expect, test } from '@jest/globals';

import { importBackAction, type ImportPhase, type ImportStage } from './importBack';

const back = (stage: ImportStage, over: { phase?: ImportPhase; sectionCount?: number; fieldsSkipped?: boolean } = {}) =>
  importBackAction({ stage, phase: over.phase ?? 'read', sectionCount: over.sectionCount ?? 1, fieldsSkipped: over.fieldsSkipped ?? false });

describe('importBackAction', () => {
  test('Preview → Fields; Fields → Sections (several subdecks) or the source; Sections → source', () => {
    expect(back('preview', { sectionCount: 3 })).toBe('fields');
    expect(back('fields', { sectionCount: 3 })).toBe('sections');
    expect(back('fields', { sectionCount: 1 })).toBe('source');
    expect(back('sections', { sectionCount: 3 })).toBe('source');
  });

  test('a Preview whose Fields stage was skipped goes to Sections or the source', () => {
    expect(back('preview', { sectionCount: 3, fieldsSkipped: true })).toBe('sections');
    expect(back('preview', { sectionCount: 1, fieldsSkipped: true })).toBe('source');
  });

  test('while Cancel is offered, back is Cancel; while saving, it closes like the ✕', () => {
    for (const phase of ['download', 'read', 'plan'] as const) expect(back('importing', { phase })).toBe('cancel');
    for (const phase of ['save', 'images'] as const) expect(back('importing', { phase })).toBe('close');
  });

  test('the source stage and Done close Import', () => {
    expect(back('source')).toBe('close');
    expect(back('done')).toBe('close');
  });
});
