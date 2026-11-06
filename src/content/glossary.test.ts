/**
 * Tests for the glossary, the Help content and the "?" InfoSheet
 * (unit W4-6; spec §1.2 glossary, §8.9 Help, §2.3 InfoSheet, §8.12 targets).
 *
 * Four parts:
 *   1. glossary.ts against the spec: the §1.2 table is READ from
 *      docs/product-spec.md, and every UI word must have exactly one entry
 *      with the spec's code word and meaning (so the app and the spec cannot
 *      drift apart without this test failing);
 *   2. help.ts: the seven §8.9 sections with stable topic ids, every Help
 *      topic id referenced by the glossary resolves, and the content says
 *      what §8.9 asks for;
 *   3. the tiny text markup (`textSpans`, `plainText`);
 *   4. InfoButton and InfoSheet, rendered with react-test-renderer: the
 *      screen-reader label, the 44 pt target, what a tap shows, the
 *      "More in Help" link and the unknown-word guard.
 *
 * Module mocks (`jest.mock` below), the same as uiKit.test.ts:
 *   - ThemeContext → useColors() returns the light palette;
 *   - safe-area-context → zero insets (Sheet);
 *   - @expo/vector-icons → icons render nothing (no async font load);
 *   - expo-router → useRouter() returns a router whose `push` is recorded.
 */
// '@jest/globals' first: the jest.mock factories below use its `jest`.
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { INFO_BUTTON_SIZE, InfoButton, infoButtonLabel } from '../components/sheets/InfoButton';
import { INFO_MORE_COPY, InfoSheet } from '../components/sheets/InfoSheet';
import { MIN_TOUCH } from '../components/ui';
import { GLOSSARY, glossaryEntry, lookupKey, plainText, requireGlossaryEntry, textSpans } from './glossary';
import {
  HELP_SECTIONS,
  HELP_TOPIC_IDS,
  type HelpBlock,
  type HelpSection,
  helpPath,
  helpSection,
  helpTopicParam,
  isHelpTopicId,
  sectionTexts,
} from './help';

jest.mock('../theme/ThemeContext', () => ({
  useColors: () => jest.requireActual<typeof import('../theme/tokens')>('../theme/tokens').light,
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// The real icon loads its font later and sets state outside act(); icons
// draw nothing a screen reader needs, so they render nothing here.
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

// `mock…` names may be used inside a jest.mock factory (it runs later).
const mockPush = jest.fn<(href: unknown) => void>();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));

const h = React.createElement;

/* ------------------------------------------------------------ the spec */

const REPO = path.resolve(__dirname, '..', '..');

interface SpecRow {
  /** The UI word without its bold markers; null for the "(not shown)" row. */
  word: string | null;
  /** The code word cell, as written (backticks included). */
  code: string;
  /** The meaning cell, as written (bold markers included). */
  meaning: string;
}

/** The rows of the spec §1.2 glossary table, in order. */
function specGlossaryRows(): SpecRow[] {
  const spec = fs.readFileSync(path.join(REPO, 'docs', 'product-spec.md'), 'utf8');
  const start = spec.indexOf('### 1.2 Glossary');
  if (start < 0) throw new Error('spec §1.2 "Glossary" not found in docs/product-spec.md');
  const end = spec.indexOf('\n---', start); // the section ends at the next rule
  const tableLines = spec
    .slice(start, end)
    .split('\n')
    .filter((line) => line.startsWith('|'));
  // tableLines[0] is the header row, tableLines[1] the |---|---|---| row.
  return tableLines.slice(2).map((line) => {
    const cells = line
      .slice(1, line.lastIndexOf('|'))
      .split(' | ')
      .map((cell) => cell.trim());
    if (cells.length !== 3) throw new Error(`a §1.2 row without 3 cells: ${line}`);
    const [word, code, meaning] = cells;
    return { word: word === '(not shown)' ? null : word.replace(/^\*\*(.*)\*\*$/, '$1'), code, meaning };
  });
}

const SPEC_ROWS = specGlossaryRows();

/* ---------------------------------------------------------- render helpers */

let renderer: ReactTestRenderer | null = null;

afterEach(() => {
  if (renderer) act(() => renderer!.unmount());
  renderer = null;
  mockPush.mockClear();
});

/** Render an element (inside act) and return the renderer. */
function render(element: React.ReactElement): ReactTestRenderer {
  act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer!;
}

/**
 * The Pressable (the component, not its host view) with this accessibility
 * label: the outermost non-host element that has the label and an `onPress` prop.
 */
function pressableByLabel(r: ReactTestRenderer, label: string): ReactTestInstance {
  const found = r.root.findAll(
    (n) => typeof n.type !== 'string' && n.props.accessibilityLabel === label && 'onPress' in n.props,
  );
  if (found.length === 0) throw new Error(`no pressable labelled "${label}"`);
  return found[0];
}

/** How many pressables have this accessibility label. */
function countPressables(r: ReactTestRenderer, label: string): number {
  return r.root.findAll(
    (n) => typeof n.type !== 'string' && n.props.accessibilityLabel === label && 'onPress' in n.props,
  ).length;
}

/** Every string drawn by a Text, joined (nested Texts included). */
function allText(r: ReactTestRenderer): string {
  return r.root
    .findAllByType(Text)
    .map((t) => (typeof t.props.children === 'string' ? t.props.children : ''))
    .join('|');
}

/** The strings of every Text that is a header (the Sheet title), in order. */
function headerTexts(r: ReactTestRenderer): string[] {
  return r.root
    .findAllByType(Text)
    .filter((t) => t.props.accessibilityRole === 'header')
    .map((t) => (typeof t.props.children === 'string' ? t.props.children : JSON.stringify(t.props.children)));
}

/** Press a pressable (inside act). */
function press(node: ReactTestInstance): void {
  act(() => {
    (node.props.onPress as () => void)();
  });
}

/** The texts of a section without its glossary terms (those are pinned against the spec above). */
function ownTexts(section: HelpSection): string[] {
  return sectionTexts({ ...section, blocks: section.blocks.filter((b) => b.kind !== 'terms') });
}

/** Every Help text of every section, without the glossary terms. */
const ALL_HELP_TEXTS = HELP_SECTIONS.flatMap(ownTexts);

/** True when every `**` and every backtick in `text` has its pair. */
function balanced(text: string): boolean {
  return text.split('**').length % 2 === 1 && text.split('`').length % 2 === 1;
}

/* ================================================== 1. glossary vs spec §1.2 */

describe('glossary.ts follows spec §1.2', () => {
  test('the §1.2 table is read from the spec (33 rows, one of them "not shown")', () => {
    expect(SPEC_ROWS).toHaveLength(33);
    expect(SPEC_ROWS.filter((row) => row.word === null)).toHaveLength(1);
    expect(SPEC_ROWS[0]).toEqual({
      word: 'Deck',
      code: '`Deck`',
      meaning: 'A container of cards that you own. Every card is in exactly one deck.',
    });
  });

  test('every §1.2 UI word has exactly one entry, with the spec code word and meaning', () => {
    for (const row of SPEC_ROWS) {
      if (row.word === null) continue;
      const matches = GLOSSARY.filter((entry) => entry.word === row.word);
      expect({ word: row.word, entries: matches.length }).toEqual({ word: row.word, entries: 1 });
      expect({ word: row.word, code: matches[0].code }).toEqual({ word: row.word, code: row.code });
      expect({ word: row.word, meaning: matches[0].meaning }).toEqual({ word: row.word, meaning: row.meaning });
    }
  });

  test('the "(not shown)" Note row is the entry "Item", without the developer rules', () => {
    const row = SPEC_ROWS.find((r) => r.word === null)!;
    expect(row.code).toBe('`Note`');
    // The spec's first two sentences, with "note" → "item" …
    expect(row.meaning.startsWith(
      'The information you enter once (field values, tags, section). A note has one card per enabled direction. ',
    )).toBe(true);
    const item = glossaryEntry('Item')!;
    expect(item.code).toBe(row.code);
    expect(item.meaning).toBe(
      'The information you enter once (field values, tags, section). An item has one card per enabled direction.',
    );
    // … and the UI word "note" is never a lookup.
    expect(glossaryEntry('Note')).toBeNull();
  });

  test('nothing else: one entry per spec row, in the spec order', () => {
    expect(GLOSSARY).toHaveLength(SPEC_ROWS.length);
    expect(GLOSSARY.map((entry) => entry.code)).toEqual(SPEC_ROWS.map((row) => row.code));
  });

  test('ids, words and aliases are unique lookups: each one finds its own entry', () => {
    const owner = new Map<string, string>();
    for (const entry of GLOSSARY) {
      for (const name of [entry.word, entry.id, ...(entry.aliases ?? [])]) {
        const key = lookupKey(name);
        const before = owner.get(key);
        expect({ name, owner: before ?? entry.id }).toEqual({ name, owner: entry.id });
        owner.set(key, entry.id);
        expect(glossaryEntry(name)).toBe(entry);
      }
    }
    expect(new Set(GLOSSARY.map((entry) => entry.id)).size).toBe(GLOSSARY.length);
  });

  test('glossaryEntry ignores case, accents and extra spaces; unknown words give null', () => {
    expect(glossaryEntry('  not   STARTED ')?.word).toBe('Not started');
    expect(glossaryEntry('séssion size')?.word).toBe('Session size');
    expect(glossaryEntry('Flag')?.word).toBe('Favorite / Flag');
    expect(glossaryEntry('favorite')?.word).toBe('Favorite / Flag');
    expect(glossaryEntry('Freeze')?.word).toBe('Streak / Freeze');
    expect(glossaryEntry('Pause deck')?.word).toBe('Pause a deck');
    expect(glossaryEntry('notStarted')?.word).toBe('Not started'); // the id
    expect(glossaryEntry('Collection')).toBeNull();
    expect(glossaryEntry('')).toBeNull();
    expect(lookupKey('  Not \n Started ')).toBe('not started');
  });

  test('requireGlossaryEntry: a known word → its entry; unknown → throws in development, null in a release', () => {
    expect(requireGlossaryEntry('Known', { dev: true })?.id).toBe('known');
    expect(requireGlossaryEntry('Known', { dev: false })?.id).toBe('known');
    expect(() => requireGlossaryEntry('Cram', { dev: true })).toThrow('"Cram" is not in the glossary');
    expect(requireGlossaryEntry('Cram', { dev: false })).toBeNull();
  });

  test('the UI never says "note", and every meaning has balanced markup', () => {
    for (const entry of GLOSSARY) {
      expect({ word: entry.word, note: /\bnotes?\b/i.test(entry.meaning) }).toEqual({ word: entry.word, note: false });
      expect({ word: entry.word, balanced: balanced(entry.meaning) }).toEqual({ word: entry.word, balanced: true });
    }
  });
});

/* ================================================ 2. Help content (spec §8.9) */

describe('help.ts: the Help sections of spec §8.9', () => {
  test('the seven sections, in order, with stable ids and the spec titles', () => {
    expect(HELP_SECTIONS.map((s) => [s.id, s.title])).toEqual([
      ['words', 'Words we use'],
      ['study', 'How Study picks cards'],
      ['filters', 'Filters and lists'],
      ['choose', 'Choosing what to learn'],
      ['import', 'Import tips'],
      ['backups', 'Backups and moving phones'],
      ['reminders', 'Reminders not arriving?'],
    ]);
    expect(HELP_SECTIONS.map((s) => s.id)).toEqual([...HELP_TOPIC_IDS]);
    expect(new Set(HELP_TOPIC_IDS).size).toBe(HELP_TOPIC_IDS.length);
  });

  test('every Help topic id referenced by the glossary resolves', () => {
    const linked = GLOSSARY.filter((entry) => entry.topic !== undefined);
    expect(linked.length).toBeGreaterThan(20); // most words link to more help
    for (const entry of linked) {
      expect({ word: entry.word, resolves: helpSection(entry.topic!) !== null }).toEqual({
        word: entry.word,
        resolves: true,
      });
    }
    // The words that a section explains link to it.
    expect(glossaryEntry('Ready')?.topic).toBe('study');
    expect(glossaryEntry('Not started')?.topic).toBe('choose');
    expect(glossaryEntry('List')?.topic).toBe('filters');
    expect(glossaryEntry('Backup')?.topic).toBe('backups');
  });

  test('"Words we use" is the glossary itself: same words, same meanings, same order', () => {
    const words = helpSection('words')!;
    const terms = words.blocks.filter((b): b is Extract<HelpBlock, { kind: 'terms' }> => b.kind === 'terms');
    expect(terms).toHaveLength(1);
    expect(terms[0].items).toEqual(GLOSSARY.map((e) => ({ id: e.id, word: e.word, text: e.meaning })));
  });

  test('"How Study picks cards": learning → due → checks → new; limits; session size; both directions', () => {
    const study = helpSection('study')!;
    const steps = study.blocks.find((b) => b.kind === 'steps');
    expect(steps?.kind).toBe('steps');
    const order = (steps as Extract<HelpBlock, { kind: 'steps' }>).items.map((item) => textSpans(item)[0].text);
    expect(order).toEqual(['Learning', 'Due', 'Checks', 'New']);
    const text = ownTexts(study).join('\n');
    expect(text).toContain('daily limit');
    expect(text).toContain('**Session size**');
    expect(text).toContain('applies to every session');
    expect(text).toContain('**Space out both directions**');
    expect(text).toContain('It never blocks cards.'); // a goal is not a limit
    expect(text).toContain('It never changes the schedule or your daily counts.'); // Practice
  });

  test('"Import tips": Support older Anki versions, CSV header names, Anki text exports, not imported yet', () => {
    const text = ownTexts(helpSection('import')!).join('\n');
    expect(text).toContain('**Support older Anki versions**');
    expect(text).toContain('`Word,Translation,Level,Type`');
    expect(text).toContain('Notes in Plain Text');
    expect(text).toContain('`#columns`');
    expect(text).toContain('Not imported yet');
    expect(text).toContain('**Audio.**');
    expect(text).toContain('`collection.anki21b`');
  });

  test('"Filters and lists", "Choosing what to learn", "Backups", "Reminders" say what §8.9 asks', () => {
    const filters = ownTexts(helpSection('filters')!).join('\n');
    expect(filters).toContain('**Save as list**');
    expect(filters).toContain('A list is not a folder.');
    const choose = ownTexts(helpSection('choose')!).join('\n');
    expect(choose).toContain('**Learn**');
    expect(choose).toContain('**I know it**');
    expect(choose).toContain('**Later**');
    const backups = ownTexts(helpSection('backups')!).join('\n');
    expect(backups).toContain('**Export a backup**');
    expect(backups).toContain('**Restore a backup**');
    expect(backups).toContain('Move to a new phone');
    const reminders = ownTexts(helpSection('reminders')!).join('\n');
    // Spec §8.7, exact: the same words as Settings › Reminders (release pass C1-1: "up to an hour", not "a few minutes").
    expect(reminders).toContain('Reminders may arrive up to an hour late. Android holds them back to save battery.');
    expect(reminders).not.toContain('a few minutes late');
    expect(reminders).toContain('**Battery optimization**');
    expect(reminders).toContain('**Open system settings**'); // the permission
  });

  test('wave 5h (I3): "Reminders not arriving?" quotes both forms of the next-reminder line (device note 9)', () => {
    const reminders = ownTexts(helpSection('reminders')!).join('\n');
    // Exact copy of Settings › Reminders (spec §8.7; reminderSync.ts `reminderStatusLine`, pinned
    // in reminderSync.test.ts): a day still to come, and a day you already studied.
    expect(reminders).toContain(
      'In Settings › Reminders, **Daily reminder** is on and the screen says when the next reminder comes, for example "Next reminder: today at 8:00 PM" or "Today is done — next: tomorrow at 8:00 PM".',
    );
    // Before, Help said the line "shows a time"; on a studied day it says "Today is done" first.
    expect(reminders).not.toContain('shows a time');
  });

  test('Help keeps one meaning per word: no "note", "collection", "cram" or "review hardest"', () => {
    for (const text of ALL_HELP_TEXTS) {
      // Code pieces are file names and tokens (`collection.anki21b`), and
      // "Notes in Plain Text" is the name of an Anki export: not our words.
      const own = textSpans(text)
        .filter((span) => span.style !== 'code')
        .map((span) => span.text)
        .join('')
        .split('Notes in Plain Text')
        .join('');
      expect({ text, bad: /\bnotes?\b|\bcollections?\b|\bcram\b|review hardest|\bcurated\b/i.test(own) }).toEqual({
        text,
        bad: false,
      });
    }
  });

  test('every Help text is non-empty, trimmed, with balanced markup and no "{n}" placeholder', () => {
    expect(ALL_HELP_TEXTS.length).toBeGreaterThan(40);
    for (const text of ALL_HELP_TEXTS) {
      expect({ text, ok: text.trim() === text && text !== '' }).toEqual({ text, ok: true });
      expect({ text, balanced: balanced(text) }).toEqual({ text, balanced: true });
      expect({ text, placeholder: /\{[a-z]+\}/i.test(text) }).toEqual({ text, placeholder: false });
    }
  });

  test('helpTopicParam, helpPath, helpSection, isHelpTopicId', () => {
    expect(helpTopicParam('study')).toBe('study');
    expect(helpTopicParam(['import', 'study'])).toBe('import');
    expect(helpTopicParam([])).toBeNull();
    expect(helpTopicParam(undefined)).toBeNull();
    expect(helpTopicParam('nope')).toBeNull();
    expect(helpTopicParam('constructor')).toBeNull(); // not an inherited name
    expect(helpPath()).toBe('/help');
    expect(helpPath('backups')).toBe('/help?topic=backups');
    for (const id of HELP_TOPIC_IDS) {
      expect(helpTopicParam(helpPath(id).split('topic=')[1])).toBe(id); // a link round-trips
      expect(helpSection(id)?.id).toBe(id);
      expect(isHelpTopicId(id)).toBe(true);
    }
    expect(helpSection('nope')).toBeNull();
    expect(isHelpTopicId('Words')).toBe(false); // ids are exact
  });

  test('sectionTexts reads every block in order, terms as word then meaning', () => {
    const texts = sectionTexts(helpSection('words')!);
    expect(texts[0]).toBe('Words we use');
    expect(texts).toContain('Deck');
    expect(texts[texts.indexOf('Deck') + 1]).toBe(GLOSSARY[0].meaning);
    const study = sectionTexts(helpSection('study')!);
    expect(study).toContain('Both directions'); // a heading
    expect(study).toContain('Buried cards, until tomorrow.'); // a bullet
  });
});

/* ======================================================= 3. the text markup */

describe('textSpans and plainText', () => {
  test('bold and code pieces, plain text around them', () => {
    expect(textSpans('Tap **Save as list**.')).toEqual([
      { text: 'Tap ', style: 'plain' },
      { text: 'Save as list', style: 'bold' },
      { text: '.', style: 'plain' },
    ]);
    expect(textSpans('Type `is:due` or **Due**')).toEqual([
      { text: 'Type ', style: 'plain' },
      { text: 'is:due', style: 'code' },
      { text: ' or ', style: 'plain' },
      { text: 'Due', style: 'bold' },
    ]);
    expect(textSpans('**a****b**')).toEqual([
      { text: 'a', style: 'bold' },
      { text: 'b', style: 'bold' },
    ]);
  });

  test('a marker without its pair, or an empty pair, stays plain text', () => {
    expect(textSpans('a ** b')).toEqual([{ text: 'a ** b', style: 'plain' }]);
    expect(textSpans('**** and ``')).toEqual([{ text: '**** and ``', style: 'plain' }]);
    expect(textSpans('one ` tick')).toEqual([{ text: 'one ` tick', style: 'plain' }]);
    expect(textSpans('')).toEqual([]);
  });

  test('plainText drops the markup only', () => {
    expect(plainText('**Study** · `is:due`')).toBe('Study · is:due');
    expect(plainText(GLOSSARY.find((e) => e.id === 'ready')!.meaning)).toBe(
      "Learning + due reviews + checks + today's new cards, inside your daily limits and session size. This is the number on every Study button.",
    );
  });
});

/* ============================================ 4. InfoButton and InfoSheet */

describe('InfoButton', () => {
  test('a "?" button named "What does {term} mean?", with a 44 pt touch target', () => {
    expect(infoButtonLabel('Known')).toBe('What does Known mean?');
    const r = render(h(InfoButton, { term: 'Known' }));
    const button = pressableByLabel(r, 'What does Known mean?');
    expect(button.props.accessibilityRole).toBe('button');
    const slop = button.props.hitSlop as number;
    expect(INFO_BUTTON_SIZE + 2 * slop).toBeGreaterThanOrEqual(MIN_TOUCH);
    // Closed: no sheet yet.
    expect(allText(r)).not.toContain('You said you already know it.');
  });

  // Adapted in W4-7: the label used the raw `term` ("What does known mean?").
  // It now says the word as the glossary spells it, so it matches the screen.
  test('a tap opens the InfoSheet with the word and its one meaning', () => {
    const r = render(h(InfoButton, { term: 'known' }));
    press(pressableByLabel(r, 'What does Known mean?'));
    // The glossary word is the title: the sheet's header says exactly "Known".
    expect(headerTexts(r)).toEqual(['Known']);
    const text = allText(r);
    expect(text).toContain('You said you already know it. It is not studied. A few Known cards come back once for a ');
    expect(text).toContain('|Check|'); // the bold piece is its own Text
  });

  test('an alias opens the entry: its title is the glossary word ("Flag" → "Favorite / Flag")', () => {
    const r = render(h(InfoButton, { term: 'Flag' }));
    // What the screen shows next to the "?" is "Flag", so that is what a screen reader says.
    press(pressableByLabel(r, 'What does Flag mean?'));
    expect(headerTexts(r)).toEqual(['Favorite / Flag']);
  });

  test('the default label says the word the learner sees, never a code id or another case', () => {
    expect(infoButtonLabel('known')).toBe('What does Known mean?');
    expect(infoButtonLabel('KNOWN')).toBe('What does Known mean?');
    expect(infoButtonLabel('flag')).toBe('What does Flag mean?'); // the alias's own spelling
    expect(infoButtonLabel('Pause deck')).toBe('What does Pause deck mean?');
    // An entry id (glossaryEntry accepts it) is never read aloud: the entry's word is.
    expect(glossaryEntry('notStarted')?.word).toBe('Not started');
    expect(infoButtonLabel('notStarted')).toBe('What does Not started mean?');
    expect(infoButtonLabel('sessionSize')).toBe('What does Session size mean?');
    const r = render(h(InfoButton, { term: 'notStarted' }));
    expect(countPressables(r, 'What does Not started mean?')).toBe(1);
    expect(countPressables(r, 'What does notStarted mean?')).toBe(0);
  });

  test('`label` replaces what a screen reader says', () => {
    const r = render(h(InfoButton, { term: 'Ready', label: 'What does ready mean?' }));
    expect(countPressables(r, 'What does ready mean?')).toBe(1);
    expect(countPressables(r, 'What does Ready mean?')).toBe(0);
  });

  test('a word that is not in the glossary throws in development', () => {
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => render(h(InfoButton, { term: 'Note' }))).toThrow('"Note" is not in the glossary');
    } finally {
      quiet.mockRestore();
      renderer = null;
    }
  });
});

describe('InfoSheet', () => {
  test('term null → nothing is shown, even when open', () => {
    const r = render(h(InfoSheet, { term: null, open: true, onClose: () => undefined }));
    expect(r.toJSON()).toBeNull();
  });

  test('closed → nothing is shown', () => {
    const r = render(h(InfoSheet, { term: 'Ready', open: false, onClose: () => undefined }));
    expect(r.toJSON()).toBeNull();
  });

  test('"More in Help" closes the sheet and opens /help at the word\'s section', () => {
    const onClose = jest.fn();
    const r = render(h(InfoSheet, { term: 'Not started', open: true, onClose }));
    expect(headerTexts(r)).toEqual(['Not started']);
    const more = pressableByLabel(r, `${INFO_MORE_COPY}, Choosing what to learn`);
    press(more);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith('/help?topic=choose');
  });

  test('a word without a Help section has no "More in Help"', () => {
    const r = render(h(InfoSheet, { term: 'Hint', open: true, onClose: () => undefined }));
    expect(allText(r)).toContain('Shows part of the answer before you reveal it.');
    expect(r.root.findAll((n) => typeof n.type !== 'string' && n.props.children === INFO_MORE_COPY)).toHaveLength(0);
  });

  test('it keeps showing the last word while it slides away (term set to null on close)', () => {
    const onClose = () => undefined;
    const r = render(h(InfoSheet, { term: 'Backup', open: true, onClose }));
    act(() => r.update(h(InfoSheet, { term: null, open: false, onClose })));
    // The dismiss animation has not finished: the sheet is still drawn, with its text.
    expect(allText(r)).toContain('One file with all your decks, cards, progress and settings.');
  });
});
