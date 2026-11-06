/**
 * The pure helpers of the card editor and the deck editor (spec §8.10, unit W3-6).
 * The load-bearing properties:
 *   - `<br>` ↔ newline round trip: typed text survives save + reopen exactly;
 *     a raw field reopened and saved draws the SAME card (seeded property
 *     tests over random HTML), and an UNCHANGED field is saved byte for byte;
 *   - every field of an imported card type is editable (splitFields covers
 *     every index) and Save is blocked only by an empty required field (an
 *     imported note that was already empty is never stuck);
 *   - the same-deck duplicate check: same folded sort field, same card type,
 *     same deck — never the note itself;
 *   - the default deck of a new card is the LAST USED deck, not the oldest;
 *   - a field is named by the ONE label rule of render.ts (fieldLabel =
 *     fieldDisplayLabel): "MarankiExample" reads "Example" (wave 5d, R6).
 */
import { describe, expect, it } from '@jest/globals';

import { BUILTIN_TYPE_IDS, builtinType } from './builtinTypes';
import {
  cardTypeOptions,
  carryFields,
  checksDuplicate,
  deckEditorStart,
  duplicateIndex,
  duplicateKey,
  fieldLabel,
  fieldsForSave,
  findDuplicate,
  firstGlyph,
  fromEditable,
  isBlankField,
  isFormatted,
  lastUsedDeckId,
  missingFields,
  noteIdsInDeck,
  parseTagInput,
  pickSuggestion,
  sortDecks,
  splitFields,
  tagsWithDraft,
  tagSuggestions,
  toEditable,
  typeById,
} from './fieldText';
import { htmlToLines } from './htmlLines';
import { plainText } from './libraryIndex';
import type { NoteType, ReviewLogEntry } from './model';
import { fieldDisplayLabel } from './render';
import { FIXED_NOW } from '../test/clock';
import { ANKI_FIXTURES, ankiFixture, RARE_CHARS } from '../test/factories';
import { makeCardV3, makeDeckV3, makeNoteV3, noteWithCards } from '../test/factoriesV3';
import { createRandom } from '../test/random';

const basic = builtinType('basic', FIXED_NOW);
const reverse = builtinType('basicReverse', FIXED_NOW);
const cloze = builtinType('cloze', FIXED_NOW);
const german = builtinType('legacyVocabDe', FIXED_NOW);

/** An imported Anki card type: no 'term'/'meaning' roles, a reverse template, a hidden field. */
const imported: NoteType = {
  id: 'nt-imported',
  name: 'German Verbs',
  kind: 'standard',
  fields: [
    { name: 'Meaning', role: 'detail', facet: 'off' },
    { name: 'Verb', role: 'detail', facet: 'off' },
    { name: 'CaseInfo', label: 'Case info', role: 'detail', facet: 'off' },
    { name: 'Level', role: 'badge', facet: 'auto' },
    { name: 'Freq', role: 'hidden', facet: 'off' },
  ],
  templates: [
    { ord: 0, name: 'EN-DE', prompt: [0, 2], answer: [1] },
    { ord: 1, name: 'DE-EN', prompt: [1], answer: [0, 2] },
  ],
  sortField: 1,
  source: { ankiMid: '1700000000' },
  createdAt: FIXED_NOW,
  updatedAt: FIXED_NOW,
};

/* ================================================================ field text */

describe('toEditable / fromEditable — <br> ↔ newline', () => {
  it('leaves plain text alone in both directions ("\\n" is already a line)', () => {
    expect(toEditable('Haus\nhouse')).toBe('Haus\nhouse');
    expect(fromEditable('Haus\nhouse')).toBe('Haus\nhouse');
    expect(fromEditable('if i<n: x')).toBe('if i<n: x'); // "<n" is not a tag
    expect(toEditable('')).toBe('');
    expect(fromEditable('')).toBe('');
  });

  it('turns every spelling of <br> into a newline', () => {
    expect(toEditable('a<br>b<br/>c<BR />d<br class="x">e')).toBe('a\nb\nc\nd\ne');
    expect(toEditable('<bra>x</bra>')).toBe('<bra>x</bra>'); // not a <br>
  });

  it('writes <br> for a newline when the text has HTML', () => {
    expect(fromEditable('ich <b>bin</b>\ndu bist')).toBe('ich <b>bin</b><br>du bist');
    expect(fromEditable('<i>a</i>\n\nb')).toBe('<i>a</i><br><br>b');
  });

  it('round-trips the canonical <br> form byte for byte', () => {
    for (const raw of ['ich bin<br>du bist<br>er ist', '<b>der</b> Hund<br><i>the dog</i>', '<div>a</div><div>b</div>']) {
      expect(fromEditable(toEditable(raw), isFormatted(raw))).toBe(raw);
    }
  });

  it('a field that WAS HTML stays HTML, also when only <br> tags were in it', () => {
    // "ich bin<br>du bist": the editable text has no tag left, but the field keeps <br>.
    expect(toEditable('ich bin<br>du bist')).toBe('ich bin\ndu bist');
    expect(fromEditable('ich bin\ndu bist!', true)).toBe('ich bin<br>du bist!');
    // A plain field (a note typed in the app, a migrated v2 card) stays plain.
    expect(fromEditable('ich bin\ndu bist!', false)).toBe('ich bin\ndu bist!');
  });

  it('turns a raw line break inside HTML into a space (the card looks the same)', () => {
    const raw = '<b>a</b>\n<i>b</i>';
    expect(toEditable(raw)).toBe('<b>a</b> <i>b</i>');
    expect(htmlToLines(fromEditable(toEditable(raw)))).toEqual(htmlToLines(raw));
    // W3-6 hardening: right after a closing block tag the card starts a new line,
    // so there the raw line break is shown as the line break it is (and kept).
    const blocks = '<div>a</div>\n<div>b</div>';
    expect(toEditable(blocks)).toBe('<div>a</div>\n<div>b</div>');
    expect(fromEditable(toEditable(blocks))).toBe(blocks);
    expect(htmlToLines(fromEditable(toEditable(blocks)))).toEqual(htmlToLines(blocks));
    // A raw break right after a <br> (or at the start) is dropped, not shown as a space.
    expect(toEditable('line1<br>\nline2')).toBe('line1\nline2');
    expect(toEditable('\n<b>x</b>')).toBe('<b>x</b>');
  });

  it('keeps the line breaks of <pre> (code) as lines', () => {
    const code = '<pre>def f():\n    return 1</pre>';
    expect(toEditable(code)).toBe(code);
    expect(fromEditable(code)).toBe(code);
    // The break right after "<pre>" is not shown by the renderer, so it is not shown here.
    expect(toEditable('<pre>\nx</pre>')).toBe('<pre>x</pre>');
    // A <br> right after "<pre>" IS shown: it comes back as <br>, not as a hidden raw break.
    expect(toEditable('<pre><br>x</pre>')).toBe('<pre>\nx</pre>');
    expect(fromEditable('<pre>\nx</pre>')).toBe('<pre><br>x</pre>');
    // A self-closing <pre/> and a stray </pre> do not switch the mode.
    expect(fromEditable('<pre/>a\nb')).toBe('<pre/>a<br>b');
    expect(fromEditable('</pre><b>a</b>\nb')).toBe('</pre><b>a</b><br>b');
  });

  it('copies HTML comments as they are (a "<pre>" inside one means nothing)', () => {
    expect(fromEditable('<!-- <pre> -->a\nb')).toBe('<!-- <pre> -->a<br>b');
    expect(toEditable('<!-- a\nb -->c<br>d')).toBe('<!-- a\nb -->c\nd');
  });

  it('property: typed text survives save and reopen exactly (seeded)', () => {
    const rnd = createRandom('fieldText:typed');
    const parts = ['a', 'Haus', ' ', '  ', '\n', '\n', '<b>', '</b>', '<i>x</i>', '<pre>', '</pre>', '&amp;', '<!-- c -->', '\t', 'ü'];
    for (let run = 0; run < 600; run++) {
      const n = rnd.int(0, 12);
      let text = '';
      for (let k = 0; k < n; k++) text += rnd.pick(parts);
      // Both kinds of field: a plain one (a new card) and one that was HTML before.
      for (const formatted of [false, true]) {
        const saved = fromEditable(text, formatted);
        expect({ run, text, formatted, back: toEditable(saved) }).toEqual({ run, text, formatted, back: text });
      }
    }
  });

  it('property: a raw field reopened and saved draws the same card (seeded)', () => {
    const rnd = createRandom('fieldText:raw');
    const parts = [
      'a', 'b c', ' ', '\n', '\r\n', '\r', '\t', '<br>', '<br/>', '<BR />', '<b>', '</b>', '<i>', '</i>',
      '<div>', '</div>', '<p>', '</p>', '<pre>', '</pre>', '&amp;', '&lt;', '<!-- x -->', '<img src="a.png">', '[sound:a.mp3]',
    ];
    for (let run = 0; run < 800; run++) {
      const n = rnd.int(0, 14);
      let raw = '';
      for (let k = 0; k < n; k++) raw += rnd.pick(parts);
      const editable = toEditable(raw);
      const saved = fromEditable(editable, isFormatted(raw));
      expect({ run, raw, lines: htmlToLines(saved) }).toEqual({ run, raw, lines: htmlToLines(raw) });
      // Reopening the saved value shows the same editable text again (no drift on every save).
      expect({ run, raw, again: toEditable(saved) }).toEqual({ run, raw, again: editable });
    }
  });
});

describe('typed "<…>" that is not HTML is text (a coding card shows "ArrayList<Integer>")', () => {
  const card = (raw: string) => htmlToLines(raw).map((line) => line.map((p) => (p.t === 'text' ? p.text : p.t)).join(''));

  it('generic types, comparisons and JSX in a new card: the card, search and the editor show what was typed', () => {
    for (const typed of [
      'ArrayList<Integer>',
      'Map<String, List<Integer>>',
      'if a<b and c>d',
      'List<Object> xs',
      'Pair<A, B>',
      'Vec<i32>',
      '<T> void f()',
      '<Foo />',
      'List<T> x\nnext line',
    ]) {
      const saved = fieldsForSave([], [], [typed])[0];
      expect({ typed, card: card(saved) }).toEqual({ typed, card: typed.split('\n') });
      expect({ typed, search: plainText(saved) }).toEqual({ typed, search: typed.replace(/\n/g, ' ') });
      // Reopened, the editor shows the typed text again; saving it again changes nothing.
      expect({ typed, back: toEditable(saved) }).toEqual({ typed, back: typed });
      expect(fromEditable(toEditable(saved), isFormatted(saved))).toBe(saved);
    }
    expect(fromEditable('ArrayList<Integer>')).toBe('ArrayList&lt;Integer&gt;');
    expect(isFormatted(fromEditable('ArrayList<Integer>'))).toBe(false); // still a plain field: "\n" is a line
  });

  it('two generic types are two different values for the duplicate check', () => {
    const a = fieldsForSave([], [], ['ArrayList<Integer>'])[0];
    const b = fieldsForSave([], [], ['ArrayList<String>'])[0];
    expect(duplicateKey(a)).not.toBe(duplicateKey(b));
  });

  it('real HTML typed in a new card is still HTML (closed tags, <br>, <img>, comments, <pre/>)', () => {
    expect(fromEditable('ich <b>bin</b>\ndu')).toBe('ich <b>bin</b><br>du');
    expect(fromEditable('a<br>b')).toBe('a<br>b');
    expect(fromEditable('<img src="a.png">\nx')).toBe('<img src="a.png"><br>x');
    expect(fromEditable('a<!-- c -->\nb')).toBe('a<!-- c --><br>b');
    expect(fromEditable('<pre/>a\nb')).toBe('<pre/>a<br>b');
    // Typed HTML is HTML: a "<T>" next to real tags is read as HTML too (raw HTML is edited as text).
    expect(fromEditable('<b>x</b> List<T>')).toBe('<b>x</b> List<T>');
  });

  it('an imported plain field with "&lt;…&gt;" shows "<…>" in the editor only when saving gives the same field back', () => {
    // CSV and v2 migration escape plain text: the editor shows it as the card does.
    expect(toEditable('List&lt;String&gt;')).toBe('List<String>');
    // Decoded, this would be real HTML (bold): it stays as it is.
    expect(toEditable('&lt;b&gt;x&lt;/b&gt;')).toBe('&lt;b&gt;x&lt;/b&gt;');
    // "a < b" is not escaped when saved (no "tag"), so the entity form stays.
    expect(toEditable('a &lt; b')).toBe('a &lt; b');
    // An HTML field is edited as raw HTML text: entities stay.
    expect(toEditable('<b>x</b> &lt;T&gt;')).toBe('<b>x</b> &lt;T&gt;');
    for (const raw of ['List&lt;String&gt;', '&lt;b&gt;x&lt;/b&gt;', 'a &lt; b', 'x<1 &lt;T&gt;', '&lt;T&gt;&gt;']) {
      const editable = toEditable(raw);
      expect({ raw, saved: fromEditable(editable, isFormatted(raw)) }).toEqual({ raw, saved: raw });
    }
  });
});

describe('a line break next to a block tag (<div>, <p> …) never adds an empty line (W3-6 hardening)', () => {
  /** What the learner types, then Save: the raw field (an edit of an HTML field). */
  const typedAndSaved = (raw: string, edited: string) => fieldsForSave([raw], [toEditable(raw)], [edited])[0];
  const lines = (raw: string) => htmlToLines(raw).map((line) => line.map((p) => (p.t === 'text' ? p.text : p.t)).join(''));

  it('Enter at the end of a <div> field, then a new line: no empty line before it', () => {
    const raw = '<div>line1</div><div>line2</div>';
    expect(lines(raw)).toEqual(['line1', 'line2']);
    const editable = toEditable(raw);
    expect(editable).toBe(raw); // no raw line break and no <br>: nothing changes in the editor
    const saved = typedAndSaved(raw, `${editable}\nline3`);
    expect(saved).toBe('<div>line1</div><div>line2</div>\nline3');
    expect(lines(saved)).toEqual(['line1', 'line2', 'line3']);
  });

  it('Enter between two <div> blocks keeps them as two lines (no empty line between)', () => {
    const raw = '<div>line1</div><div>line2</div>';
    const saved = typedAndSaved(raw, '<div>line1</div>\n<div>line2</div>');
    expect(lines(saved)).toEqual(['line1', 'line2']);
    // Two presses of Enter ARE an empty line.
    expect(lines(typedAndSaved(raw, '<div>line1</div>\n\n<div>line2</div>'))).toEqual(['line1', '', 'line2']);
  });

  it('a <br> right after a block is an empty line on the card, and two line breaks in the editor', () => {
    const raw = '<div>a</div><br>b';
    expect(lines(raw)).toEqual(['a', '', 'b']);
    expect(toEditable(raw)).toBe('<div>a</div>\n\nb');
    const saved = fromEditable(toEditable(raw), true);
    expect(lines(saved)).toEqual(['a', '', 'b']);
    expect(toEditable(saved)).toBe('<div>a</div>\n\nb');
  });

  it('every closing block tag of the list really ends a line in the renderer', () => {
    const tags = [
      'address', 'article', 'aside', 'blockquote', 'center', 'dd', 'details', 'div', 'dl', 'dt', 'figcaption',
      'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p',
      'pre', 'section', 'summary', 'table', 'tbody', 'tfoot', 'thead', 'tr', 'ul',
    ];
    for (const tag of tags) {
      const typed = `x</${tag}>\ny`;
      const saved = fromEditable(typed, true);
      expect({ tag, saved, lines: htmlToLines(saved).length }).toEqual({ tag, saved: `x</${tag}>\ny`, lines: 2 });
      expect({ tag, back: toEditable(saved) }).toEqual({ tag, back: typed });
    }
    // Not a block tag: an inline close still needs a <br> for its line break.
    expect(fromEditable('<b>x</b>\ny')).toBe('<b>x</b><br>y');
    expect(fromEditable('<span>x</span>\ny')).toBe('<span>x</span><br>y');
    // "</pa>" is not "</p>" (in an HTML field), and a block tag inside <pre> keeps the <pre> rule.
    expect(fromEditable('x</pa>\ny', true)).toBe('x</pa><br>y');
    // In a plain field "</pa>" is not HTML at all (no such element, nothing opened it): it is text.
    expect(fromEditable('x</pa>\ny')).toBe('x&lt;/pa&gt;\ny');
    expect(fromEditable('<pre>x</div>\ny</pre>')).toBe('<pre>x</div>\ny</pre>');
  });

  it('property: one typed line = one line on the card, with blocks and inline tags mixed (seeded)', () => {
    const rnd = createRandom('fieldText:blocks');
    const segments = ['<div>a</div>', '<p>b</p>', 'c', '<b>d</b>', '<li>e</li>', '<div><b>f</b></div>', 'g h'];
    for (let run = 0; run < 400; run++) {
      const n = rnd.int(1, 7);
      const typed: string[] = [];
      for (let k = 0; k < n; k++) typed.push(rnd.pick(segments));
      const text = typed.join('\n');
      const saved = fromEditable(text, true);
      expect({ run, text, lines: htmlToLines(saved).length }).toEqual({ run, text, lines: n });
      expect({ run, text, back: toEditable(saved) }).toEqual({ run, text, back: text });
    }
  });

  it('Enter right after an <hr> (any spelling): no empty line (A5 review round 1)', () => {
    // The renderer ends the line at <hr>, like at a closing block tag.
    expect(lines('a<hr>b')).toEqual(['a', 'b']);
    expect(lines(typedAndSaved('a<hr>b', 'a<hr>\nb'))).toEqual(['a', 'b']);
    expect(typedAndSaved('a<hr>b', 'a<hr>\nb')).toBe('a<hr>\nb');
    for (const hr of ['<hr>', '<hr/>', '<hr />', '<HR class="x">']) {
      const saved = fromEditable(`a${hr}\nb`, true);
      expect({ hr, saved, lines: lines(saved) }).toEqual({ hr, saved: `a${hr}\nb`, lines: ['a', 'b'] });
      expect({ hr, back: toEditable(saved) }).toEqual({ hr, back: `a${hr}\nb` });
    }
    // Two presses of Enter ARE an empty line; a <br> after an <hr> shows as two line breaks.
    expect(lines(typedAndSaved('a<hr>b', 'a<hr>\n\nb'))).toEqual(['a', '', 'b']);
    expect(lines('a<hr><br>b')).toEqual(['a', '', 'b']);
    expect(toEditable('a<hr><br>b')).toBe('a<hr>\n\nb');
    expect(lines(fromEditable(toEditable('a<hr><br>b'), true))).toEqual(['a', '', 'b']);
    // "<hra>" is not an <hr>: an inline tag (in an HTML field) still needs a <br> for its line break.
    expect(fromEditable('a<hra>\nb', true)).toBe('a<hra><br>b');
    // In a plain field "<hra>" is not HTML at all: it is text, and "\n" stays a line.
    expect(fromEditable('a<hra>\nb')).toBe('a&lt;hra&gt;\nb');
    // An OPENING block tag is not a block end: Anki's empty line "<div><br></div>" stays byte for byte.
    const anki = '<div>a</div><div><br></div><div>b</div>';
    expect(lines(anki)).toEqual(['a', '', 'b']);
    expect(fromEditable(toEditable(anki), true)).toBe(anki);
  });

  it('Enter after a comment that follows a block end: no empty line (A5 review round 1)', () => {
    const raw = '<div>a</div><!-- c -->b';
    expect(lines(raw)).toEqual(['a', 'b']);
    const saved = typedAndSaved(raw, '<div>a</div><!-- c -->\nb');
    expect(saved).toBe('<div>a</div><!-- c -->\nb');
    expect(lines(saved)).toEqual(['a', 'b']);
    expect(toEditable(saved)).toBe('<div>a</div><!-- c -->\nb');
    // Two comments, and an <hr> before the comment: the same.
    expect(lines(fromEditable('<p>a</p><!-- 1 --><!-- 2 -->\nb', true))).toEqual(['a', 'b']);
    expect(lines(fromEditable('a<hr><!-- c -->\nb', true))).toEqual(['a', 'b']);
    // A <br> after the comment is an empty line, shown as two line breaks.
    expect(toEditable('<div>a</div><!-- c --><br>b')).toBe('<div>a</div><!-- c -->\n\nb');
    expect(lines(fromEditable(toEditable('<div>a</div><!-- c --><br>b'), true))).toEqual(['a', '', 'b']);
    // A comment after plain text is not a block end: the line break is a <br>.
    expect(fromEditable('a<!-- c -->\nb', true)).toBe('a<!-- c --><br>b');
    expect(lines(fromEditable('a<!-- c -->\nb', true))).toEqual(['a', 'b']);
  });

  it('property: one typed line = one line, also with <hr> and comments (seeded)', () => {
    const rnd = createRandom('fieldText:blocks-hr');
    const segments = ['<div>a</div>', 'c', '<b>d</b>', 'i<hr>', 'j<HR/>', '<p>k</p><!-- c -->', 'l<!-- c -->', '<li>m</li><!-- x --><!-- y -->'];
    for (let run = 0; run < 400; run++) {
      const n = rnd.int(1, 7);
      const typed: string[] = [];
      for (let k = 0; k < n; k++) typed.push(rnd.pick(segments));
      const text = typed.join('\n');
      const saved = fromEditable(text, true);
      expect({ run, text, lines: htmlToLines(saved).length }).toEqual({ run, text, lines: n });
      expect({ run, text, back: toEditable(saved) }).toEqual({ run, text, back: text });
    }
  });

  it('property: a raw field with <hr> and comments, reopened and saved, draws the same card (seeded)', () => {
    const rnd = createRandom('fieldText:raw-hr');
    const parts = ['a', 'b c', ' ', '\n', '\r\n', '<br>', '<hr>', '<hr/>', '</div>', '<div>', '</p>', '<!-- x -->', '<pre>', '</pre>', '<b>', '</b>'];
    for (let run = 0; run < 800; run++) {
      const n = rnd.int(0, 14);
      let raw = '';
      for (let k = 0; k < n; k++) raw += rnd.pick(parts);
      const editable = toEditable(raw);
      const saved = fromEditable(editable, isFormatted(raw));
      expect({ run, raw, lines: htmlToLines(saved) }).toEqual({ run, raw, lines: htmlToLines(raw) });
      expect({ run, raw, again: toEditable(saved) }).toEqual({ run, raw, again: editable });
    }
  });
});

describe('Anki fields (the five deck fixtures)', () => {
  const fields = [
    RARE_CHARS,
    `<div>${RARE_CHARS}</div>`,
    ...ANKI_FIXTURES.flatMap((name) => ankiFixture(name).notes.flatMap((n) => n.flds.split('\x1f'))),
  ];

  it('the fixtures have HTML fields with <br> to test', () => {
    expect(fields.length).toBeGreaterThan(100);
    expect(fields.filter((f) => /<br/i.test(f)).length).toBeGreaterThan(5);
  });

  it('every field reopened and saved draws the same card, and reopens the same', () => {
    for (const raw of fields) {
      const editable = toEditable(raw);
      const saved = fromEditable(editable, isFormatted(raw));
      expect({ raw, lines: htmlToLines(saved) }).toEqual({ raw, lines: htmlToLines(raw) });
      expect({ raw, again: toEditable(saved) }).toEqual({ raw, again: editable });
    }
  });

  it('a small edit keeps every line break of the field', () => {
    let checked = 0;
    for (const raw of fields.filter((f) => /<br/i.test(f))) {
      const editable = toEditable(raw);
      // Type "!" at the end of a text line (a "\n" that follows text, not a tag).
      let at = -1;
      for (let i = 1; i < editable.length && at < 0; i++) {
        if (editable[i] === '\n' && !'>\n'.includes(editable[i - 1])) at = i;
      }
      if (at < 0) continue;
      const edited = `${editable.slice(0, at)}!${editable.slice(at)}`;
      const saved = fieldsForSave([raw], [editable], [edited])[0];
      expect({ raw, lines: htmlToLines(saved).length }).toEqual({ raw, lines: htmlToLines(raw).length });
      expect(saved).toContain('!<br>');
      checked += 1;
    }
    expect(checked).toBeGreaterThan(5);
  });
});

describe('isFormatted / isBlankField', () => {
  it('a field is "formatted" when it holds a real tag', () => {
    expect(isFormatted('<b>Haus</b>')).toBe(true);
    expect(isFormatted('ich bin<br>du bist')).toBe(true);
    expect(isFormatted('Haus')).toBe(false);
    expect(isFormatted('if i<n:')).toBe(false);
  });

  it('a field is blank when it draws nothing', () => {
    expect(isBlankField('')).toBe(true);
    expect(isBlankField('   \n ')).toBe(true);
    expect(isBlankField('<b></b><br>')).toBe(true);
    expect(isBlankField('<img src="cat.png">')).toBe(false);
    expect(isBlankField('[sound:haus.mp3]')).toBe(false);
    expect(isBlankField('x')).toBe(false);
  });
});

describe('fieldsForSave', () => {
  it('keeps an unchanged field byte for byte and converts a changed one', () => {
    const raw = ['a<br/>b', '<div>x</div>\n', 'old', 'ich bin<br>du bist'];
    const initial = raw.map(toEditable);
    const edited = [initial[0], initial[1], 'new\n<b>line</b>  ', 'ich bin\ndu bist\ner ist'];
    expect(fieldsForSave(raw, initial, edited)).toEqual([
      'a<br/>b',
      '<div>x</div>\n',
      'new<br><b>line</b>',
      'ich bin<br>du bist<br>er ist', // edits keep line breaks
    ]);
  });

  it('trims a changed plain field and keeps its line breaks', () => {
    expect(fieldsForSave(['', ''], ['', ''], ['  Haus ', 'line 1\nline 2\n'])).toEqual(['Haus', 'line 1\nline 2']);
  });
});

/* ================================================================ card types */

describe('typeById / fieldLabel', () => {
  it('finds a stored type, falls back to a built-in one, and says null for an unknown id', () => {
    expect(typeById([imported], 'nt-imported')).toBe(imported);
    expect(typeById([], BUILTIN_TYPE_IDS.basicReverse)?.name).toBe('Basic + reverse');
    expect(typeById([], 'nt-missing')).toBeNull();
    expect(typeById([], null)).toBeNull();
  });

  it('a field shows its label, else its name', () => {
    expect(fieldLabel(imported.fields[2])).toBe('Case info');
    expect(fieldLabel(imported.fields[0])).toBe('Meaning');
    expect(fieldLabel({ name: 'X', label: '  ' })).toBe('X');
  });

  // Wave 5d (R6): fieldLabel returned `label ?? name`, so the deck page's "Card types & fields"
  // and "Read aloud" sheets showed raw names ("MarankiExample", "VerbForms") in the generic build.
  it('a field with no label shows its name made READABLE: the one label rule of render.ts (fieldDisplayLabel)', () => {
    expect(fieldLabel({ name: 'MarankiExample' })).toBe('Example');
    expect(fieldLabel({ name: 'VerbForms' })).toBe('Verb Forms');
    expect(fieldLabel({ name: 'CaseInfo', label: '' })).toBe('Case Info');
    expect(fieldLabel({ name: 'example_translation' })).toBe('Example translation');
    // A label someone chose wins, as it is.
    expect(fieldLabel({ name: 'Prateritum', label: 'Präteritum' })).toBe('Präteritum');
    expect(fieldLabel({ name: 'Tags', label: 'Verb type' })).toBe('Verb type');
    // ONE rule: the same words as the cards and every other screen, for every field of every type here.
    for (const type of [basic, reverse, imported]) {
      for (const f of type.fields) expect(fieldLabel(f)).toBe(fieldDisplayLabel(f));
    }
    for (const name of ['MarankiExample', 'VerbForms', 'IPAText', 'Back Extra', 'Front', 'Maranki']) {
      expect(fieldLabel({ name })).toBe(fieldDisplayLabel({ name }));
    }
  });

  it('the card type picker names the fields readably too (cardTypeOptions sub line)', () => {
    const raw: NoteType = {
      ...imported,
      id: 'nt-raw',
      name: 'Raw names',
      fields: [
        { name: 'VerbForms', role: 'detail', facet: 'off' },
        { name: 'MarankiExample', role: 'detail', facet: 'off' },
        { name: 'CaseInfo', role: 'detail', facet: 'off' },
      ],
    };
    const sub = cardTypeOptions([raw], [], new Set(), raw).find((o) => o.id === 'nt-raw')?.sub ?? '';
    expect(sub).toContain('Verb Forms');
    expect(sub).toContain('Example');
    expect(sub).not.toMatch(/VerbForms|MarankiExample|CaseInfo/);
  });
});

describe('splitFields — main fields and "More fields"', () => {
  it('Basic: Front and Back, then Example and Notes', () => {
    expect(splitFields(basic)).toEqual({ main: [0, 1], more: [2, 3] });
    expect(splitFields(reverse)).toEqual({ main: [0, 1], more: [2, 3] });
  });

  it('Cloze: the Text field, then Extra', () => {
    expect(splitFields(cloze)).toEqual({ main: [0], more: [1] });
  });

  it('legacy vocabulary: Word and Translation; every other field under More', () => {
    expect(splitFields(german)).toEqual({ main: [0, 1], more: [2, 3, 4, 5, 6, 7, 8, 9] });
  });

  it('an imported type without roles: the sort field and the first answer field; EVERY field is listed once', () => {
    const split = splitFields(imported);
    expect(split.main).toEqual([1]); // sort field Verb; the answer of ord 0 is Verb too
    expect([...split.main, ...split.more].sort()).toEqual([0, 1, 2, 3, 4]);
    const other: NoteType = { ...imported, sortField: 0 };
    expect(splitFields(other).main).toEqual([0, 1]); // Meaning (sort field) + Verb (first answer)
  });

  it('a type with no fields has nothing to show', () => {
    expect(splitFields({ ...imported, fields: [], templates: [] })).toEqual({ main: [], more: [] });
  });
});

describe('missingFields — what blocks Save', () => {
  it('a new Basic card needs Front and Back', () => {
    expect(missingFields(basic, ['', '', '', ''])).toEqual([
      { index: 0, reason: 'empty' },
      { index: 1, reason: 'empty' },
    ]);
    expect(missingFields(basic, ['Haus', '<b></b>', 'ex', ''])).toEqual([{ index: 1, reason: 'empty' }]);
    expect(missingFields(basic, ['Haus', 'house', '', ''])).toEqual([]);
    expect(missingFields(basic, ['<img src="cat.png">', 'cat', '', ''])).toEqual([]);
  });

  it('a new cloze card needs a deletion in Text', () => {
    expect(missingFields(cloze, ['Berlin is big', ''])).toEqual([{ index: 0, reason: 'noCloze' }]);
    expect(missingFields(cloze, ['{{c1::Berlin}} is big', ''])).toEqual([]);
  });

  it('editing: a field that was already empty may stay empty; a filled one may not be emptied', () => {
    const initial = ['Haus', '', '', ''];
    expect(missingFields(basic, ['Haus 2', '', '', ''], initial)).toEqual([]);
    expect(missingFields(basic, ['', '', '', ''], initial)).toEqual([{ index: 0, reason: 'empty' }]);
    // A cloze note imported without a deletion can still be fixed or saved.
    expect(missingFields(cloze, ['plain text', ''], ['plain', ''])).toEqual([]);
    expect(missingFields(cloze, ['no deletion now', ''], ['{{c1::x}}', ''])).toEqual([{ index: 0, reason: 'noCloze' }]);
  });
});

describe('carryFields — switching the card type keeps typed text', () => {
  it('same names carry over', () => {
    expect(carryFields(basic, ['Haus', 'house', 'Das Haus ist groß.', 'n'], reverse)).toEqual([
      'Haus',
      'house',
      'Das Haus ist groß.',
      'n',
    ]);
  });

  it('otherwise the same role carries over', () => {
    expect(carryFields(basic, ['Haus', 'house', '', 'a note'], cloze)).toEqual(['Haus', 'a note']);
    expect(carryFields(cloze, ['{{c1::Berlin}}', 'extra'], basic)).toEqual(['{{c1::Berlin}}', '', '', 'extra']);
  });

  it('names are compared folded (case, accents, spaces)', () => {
    const to: NoteType = { ...basic, fields: [{ name: '  front ', role: 'detail', facet: 'off' }] };
    expect(carryFields(basic, ['Haus', 'house', '', ''], to)).toEqual(['Haus']);
  });
});

describe('cardTypeOptions', () => {
  it("lists the deck's own card types first (most used), then Basic, Basic + reverse and Cloze", () => {
    const a = noteWithCards({ deckId: 'd1', typeId: 'nt-imported' }, [imported]);
    const b = noteWithCards({ deckId: 'd1', typeId: 'nt-imported' }, [imported]);
    const c = noteWithCards({ deckId: 'd1', typeId: BUILTIN_TYPE_IDS.basicReverse });
    const elsewhere = noteWithCards({ deckId: 'd2', typeId: BUILTIN_TYPE_IDS.cloze, fields: ['{{c1::x}}', ''] });
    const notes = [a.note, b.note, c.note, elsewhere.note];
    const cards = [...a.cards, ...b.cards, ...c.cards, ...elsewhere.cards];
    const options = cardTypeOptions([imported, reverse], notes, noteIdsInDeck(cards, 'd1'));
    expect(options.map((o) => o.id)).toEqual(['nt-imported', 'nt-basic-reverse', 'nt-basic', 'nt-cloze']);
    expect(options[0]).toEqual({ id: 'nt-imported', name: 'German Verbs', sub: '2 directions · Meaning, Verb, Case info, Level, Freq' });
    expect(options.find((o) => o.id === 'nt-basic')?.sub).toBe('1 direction · Front, Back, Example, Notes');
    expect(options.find((o) => o.id === 'nt-cloze')?.sub).toBe('Cloze · Text, Extra');
  });

  it('an empty deck offers the built-in types only', () => {
    expect(cardTypeOptions([], [], new Set()).map((o) => o.name)).toEqual(['Basic', 'Basic + reverse', 'Cloze']);
  });

  it('always lists the type the form uses now (a preset typeId from another deck), first', () => {
    expect(cardTypeOptions([imported], [], new Set(), imported).map((o) => o.id)).toEqual([
      'nt-imported',
      'nt-basic',
      'nt-basic-reverse',
      'nt-cloze',
    ]);
    // Already listed: not twice, and the order does not change.
    expect(cardTypeOptions([], [], new Set(), reverse).map((o) => o.id)).toEqual(['nt-basic', 'nt-basic-reverse', 'nt-cloze']);
  });
});

/* ===================================================================== tags */

describe('tags', () => {
  it('splits typed tags on white space and commas, keeping "::"', () => {
    expect(parseTagInput('verb, irregular  A1')).toEqual(['verb', 'irregular', 'A1']);
    expect(parseTagInput(' German::Verbs::B1 ')).toEqual(['German::Verbs::B1']);
    expect(parseTagInput(' , ')).toEqual([]);
  });

  it('adds the tag still being typed and drops repeats (any case)', () => {
    expect(tagsWithDraft(['verb'], ' Verb irregular')).toEqual(['verb', 'irregular']);
    expect(tagsWithDraft([], '')).toEqual([]);
  });

  it('suggests the tags of this deck, the most used first, without the chosen ones', () => {
    const n1 = makeNoteV3({ id: 'n1', tags: ['verb', 'A1'] });
    const n2 = makeNoteV3({ id: 'n2', tags: ['Verb', 'irregular'] });
    const n3 = makeNoteV3({ id: 'n3', tags: ['noun'] }); // another deck
    const inDeck = new Set(['n1', 'n2']);
    expect(tagSuggestions([n1, n2, n3], inDeck, [])).toEqual(['verb', 'A1', 'irregular']);
    expect(tagSuggestions([n1, n2, n3], inDeck, ['VERB'])).toEqual(['A1', 'irregular']);
    expect(tagSuggestions([n1, n2, n3], inDeck, [], 1)).toEqual(['verb']);
  });

  it('suggests only the tags that start with the word being typed (case and accents ignored)', () => {
    const n1 = makeNoteV3({ id: 'n1', tags: ['verb', 'Verben', 'noun', 'Übung'] });
    const inDeck = new Set(['n1']);
    // (Same use count → A–Z by code unit, so "Verben" comes before "verb".)
    expect(tagSuggestions([n1], inDeck, [], 8, 'ver')).toEqual(['Verben', 'verb']);
    expect(tagSuggestions([n1], inDeck, [], 8, ' VER ')).toEqual(['Verben', 'verb']);
    expect(tagSuggestions([n1], inDeck, [], 8, 'ub')).toEqual(['Übung']);
    expect(tagSuggestions([n1], inDeck, [], 8, '')).toHaveLength(4);
    expect(tagSuggestions([n1], inDeck, [], 8, 'xyz')).toEqual([]);
  });

  it('a suggestion tap finishes the half-typed tag: no extra tag on Save (W3-6 hardening)', () => {
    // "ver" typed, then "+ verb" tapped: the chip is "verb" and the box is empty.
    const tapped = pickSuggestion(['noun'], 'ver', 'verb');
    expect(tapped).toEqual({ tags: ['noun', 'verb'], draft: '' });
    // What the card editor saves (the chips plus the draft): no "ver".
    expect(tagsWithDraft(tapped.tags, tapped.draft)).toEqual(['noun', 'verb']);
    // Case and accents do not matter; an empty box stays empty.
    expect(pickSuggestion([], 'UB', 'Übung')).toEqual({ tags: ['Übung'], draft: '' });
    expect(pickSuggestion([], '', 'verb')).toEqual({ tags: ['verb'], draft: '' });
    // A tag that does not finish the typed word is added, and the typing goes on.
    expect(pickSuggestion([], 'irr', 'verb')).toEqual({ tags: ['verb'], draft: 'irr' });
    // A tag already chosen (any case) is not added twice.
    expect(pickSuggestion(['Verb'], 've', 'verb')).toEqual({ tags: ['Verb'], draft: '' });
  });
});

/* ==================================================================== decks */

describe('decks', () => {
  it('sorts decks by order, then age, then name', () => {
    const decks = [
      makeDeckV3({ id: 'c', name: 'C', order: 2 }),
      makeDeckV3({ id: 'b', name: 'B', order: 1, createdAt: 5 }),
      makeDeckV3({ id: 'a', name: 'A', order: 1, createdAt: 5 }),
      makeDeckV3({ id: 'z', name: 'Z', order: 0 }),
    ];
    expect(sortDecks(decks).map((d) => d.id)).toEqual(['z', 'a', 'b', 'c']);
  });

  it('noteIdsInDeck reads the cards (a note has no deckId)', () => {
    const cards = [makeCardV3({ noteId: 'n1', deckId: 'd1' }), makeCardV3({ noteId: 'n1', deckId: 'd1', ord: 1 }), makeCardV3({ noteId: 'n2', deckId: 'd2' })];
    expect([...noteIdsInDeck(cards, 'd1')]).toEqual(['n1']);
    expect(noteIdsInDeck(cards, null).size).toBe(0);
  });

  describe('lastUsedDeckId — never simply the oldest deck', () => {
    const oldest = makeDeckV3({ id: 'old', name: 'Old', order: 0, createdAt: 1 });
    const spanish = makeDeckV3({ id: 'es', name: 'Spanish', order: 1, createdAt: 2 });
    const paused = makeDeckV3({ id: 'p', name: 'Paused', order: 0, createdAt: 0, active: false });
    const log = (deckId: string) => [{ deckId } as Pick<ReviewLogEntry, 'deckId'>];

    it('the deck of the newest note made in the app', () => {
      const typed = noteWithCards({ deckId: 'es', note: { createdAt: 50, source: { kind: 'manual' } } });
      const imported2 = noteWithCards({ deckId: 'old', note: { createdAt: 90, source: { kind: 'apkg' } } });
      const state = {
        decks: [oldest, spanish],
        notes: [typed.note, imported2.note],
        cards: [...typed.cards, ...imported2.cards],
        reviewLog: log('old'),
      };
      expect(lastUsedDeckId(state)).toBe('es');
    });

    it('else the deck of the newest rating, else the first active deck, else the first deck', () => {
      expect(lastUsedDeckId({ decks: [oldest, spanish], notes: [], cards: [], reviewLog: log('es') })).toBe('es');
      expect(lastUsedDeckId({ decks: [oldest, spanish], notes: [], cards: [], reviewLog: log('gone') })).toBe('old');
      expect(lastUsedDeckId({ decks: [paused, spanish], notes: [], cards: [], reviewLog: [] })).toBe('es');
      expect(lastUsedDeckId({ decks: [paused], notes: [], cards: [], reviewLog: [] })).toBe('p');
      expect(lastUsedDeckId({ decks: [], notes: [], cards: [], reviewLog: [] })).toBeNull();
    });

    it('skips a newest note whose deck is gone', () => {
      const typed = noteWithCards({ deckId: 'gone', note: { createdAt: 50, source: { kind: 'manual' } } });
      expect(lastUsedDeckId({ decks: [oldest, spanish], notes: [typed.note], cards: typed.cards, reviewLog: log('es') })).toBe('es');
    });
  });
});

/* =============================================================== duplicates */

describe('duplicates — same folded sort field, same card type, same deck', () => {
  const comer = noteWithCards({ deckId: 'd1', fields: ['<b>Comer</b>', 'to eat', '', ''], note: { id: 'n-comer' } });
  const otherDeck = noteWithCards({ deckId: 'd2', fields: ['beber', 'to drink', '', ''], note: { id: 'n-beber' } });
  const otherType = noteWithCards({ deckId: 'd1', typeId: BUILTIN_TYPE_IDS.basicReverse, fields: ['vivir', 'to live', '', ''], note: { id: 'n-vivir' } });
  const notes = [comer.note, otherDeck.note, otherType.note];
  const cards = [...comer.cards, ...otherDeck.cards, ...otherType.cards];
  const index = duplicateIndex(notes, noteIdsInDeck(cards, 'd1'), basic);

  it('folds case, accents and HTML', () => {
    expect(duplicateKey('<b>Cómer</b>')).toBe('comer');
    expect(duplicateKey('{{c1::Berlin}} is big')).toBe('berlin is big');
    expect(duplicateKey('  ')).toBe('');
  });

  it('finds the note with the same sort field in this deck and type', () => {
    expect(findDuplicate(index, 'comer')).toBe('n-comer');
    expect(findDuplicate(index, ' COMER ')).toBe('n-comer');
  });

  it('never the note itself, another deck, another card type, or an empty value', () => {
    expect(findDuplicate(index, 'comer', 'n-comer')).toBeNull();
    expect(findDuplicate(index, 'beber')).toBeNull();
    expect(findDuplicate(index, 'vivir')).toBeNull();
    expect(findDuplicate(index, '')).toBeNull();
  });

  it('a second note with the same text is found when editing the first', () => {
    const twin = noteWithCards({ deckId: 'd1', fields: ['comer', 'to eat (2)', '', ''], note: { id: 'n-twin' } });
    const idx = duplicateIndex([...notes, twin.note], noteIdsInDeck([...cards, ...twin.cards], 'd1'), basic);
    expect(findDuplicate(idx, 'comer', 'n-comer')).toBe('n-twin');
  });

  it('when the check runs: a new card always; an edit when the sort field changed or the deck changed', () => {
    expect(checksDuplicate({ editing: false, deckMoved: false, sortText: 'comer', startSortText: '' })).toBe(true);
    expect(checksDuplicate({ editing: true, deckMoved: false, sortText: 'comer', startSortText: 'comer' })).toBe(false);
    expect(checksDuplicate({ editing: true, deckMoved: false, sortText: 'comer 2', startSortText: 'comer' })).toBe(true);
    // W3-6 hardening: the sort field did not change, but the note moves.
    expect(checksDuplicate({ editing: true, deckMoved: true, sortText: 'comer', startSortText: 'comer' })).toBe(true);
  });

  it('moving "comer" into a deck that already has "comer" warns (same type, the target deck)', () => {
    // n-comer lives in d1. d3 has its own "comer" of the same card type.
    const there = noteWithCards({ deckId: 'd3', fields: ['comer', 'to eat', '', ''], note: { id: 'n-comer-d3' } });
    const all = [...notes, there.note];
    const allCards = [...cards, ...there.cards];
    // The editor's index is the one of the deck chosen NOW (d3), and the edited note is never its own duplicate.
    const target = duplicateIndex(all, noteIdsInDeck(allCards, 'd3'), basic);
    const moving = { editing: true, deckMoved: true, sortText: '<b>Comer</b>', startSortText: '<b>Comer</b>' };
    const dup = checksDuplicate(moving) ? findDuplicate(target, fromEditable(moving.sortText), 'n-comer') : null;
    expect(dup).toBe('n-comer-d3');
    // Staying in d1 with the same text: no warning.
    const staying = { ...moving, deckMoved: false };
    expect(checksDuplicate(staying)).toBe(false);
  });
});

describe('deckEditorStart — a deck that is gone is never a "New deck" form (W3-6 hardening)', () => {
  const decks = [makeDeckV3({ id: 'd1', name: 'Spanish' })];

  it('no deckId: a new deck; a deck in the library: edit it', () => {
    expect(deckEditorStart(decks, undefined)).toEqual({ kind: 'new' });
    expect(deckEditorStart(decks, '')).toEqual({ kind: 'new' });
    expect(deckEditorStart(decks, 'd1')).toEqual({ kind: 'edit', deck: decks[0] });
  });

  it('a deckId that is not in the library: "missing"', () => {
    expect(deckEditorStart(decks, 'd-deleted')).toEqual({ kind: 'missing' });
    expect(deckEditorStart([], 'd1')).toEqual({ kind: 'missing' });
  });
});

/* ==================================================================== icons */

describe('firstGlyph — one emoji for the deck icon', () => {
  it('keeps glyphs made of several code points whole', () => {
    expect(firstGlyph('🇩🇪 German')).toBe('🇩🇪'); // flag = 2 regional letters
    expect(firstGlyph('👍🏽👍')).toBe('👍🏽'); // skin tone
    expect(firstGlyph('👨‍👩‍👧 family')).toBe('👨‍👩‍👧'); // joined with ZWJ
    expect(firstGlyph('1️⃣2')).toBe('1️⃣'); // keycap
    expect(firstGlyph('❤️x')).toBe('❤️'); // variation selector
    expect(firstGlyph('🏴󠁧󠁢󠁳󠁣󠁴󠁿')).toBe('🏴󠁧󠁢󠁳󠁣󠁴󠁿'); // tag sequence
  });

  it('takes one letter of plain text and trims', () => {
    expect(firstGlyph('  ab')).toBe('a');
    expect(firstGlyph('📚')).toBe('📚');
    expect(firstGlyph('   ')).toBe('');
    expect(firstGlyph('')).toBe('');
  });
});
