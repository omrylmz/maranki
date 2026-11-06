/**
 * The safe HTML subset (spec §6.2, unit W2-3): Anki field HTML → lines of
 * inlines, with nothing executable left and in linear time.
 */
import { describe, expect, it } from '@jest/globals';

import { ANKI_FIXTURES, ankiFixture, RARE_CHARS } from '../test/factories';
import { stripHtml } from './anki';
import { hasHtmlTags, htmlToLines, htmlToPlain, linesToPlain } from './htmlLines';
import type { Inline } from './model';

/** A text inline, with optional styles: txt('bin', { b: true }). */
const txt = (text: string, styles: Partial<Record<'b' | 'i' | 'u' | 'sub' | 'sup', true>> = {}): Inline => ({
  t: 'text',
  text,
  ...styles,
});

/** Each line as one string (styles ignored) — a compact view. */
const asText = (html: string) =>
  htmlToLines(html).map((line) => line.map((p) => (p.t === 'text' ? p.text : `<${p.t}:${p.src}>`)).join(''));

describe('lines', () => {
  it('<br> starts a new line (a conjugation table shows as lines)', () => {
    expect(htmlToLines('ich bin<br>du bist<br/>er ist')).toEqual([
      [txt('ich bin')],
      [txt('du bist')],
      [txt('er ist')],
    ]);
  });

  it('div / p / li / tr start a new line, open or closed, without empty lines between blocks', () => {
    expect(asText('<div>a</div><div>b</div>')).toEqual(['a', 'b']);
    expect(asText('first<div>second</div><div>third</div>')).toEqual(['first', 'second', 'third']);
    expect(asText('<p>one</p><p>two</p>')).toEqual(['one', 'two']);
    expect(asText('<table><tr><td>ich</td><td>bin</td></tr><tr><td>du</td><td>bist</td></tr></table>')).toEqual([
      'ich bin',
      'du bist',
    ]);
  });

  it('lists get a bullet, numbered lists a number', () => {
    expect(asText('<ul><li>Topic alpha</li><li>Topic beta</li></ul>')).toEqual([
      '• Topic alpha',
      '• Topic beta',
    ]);
    expect(asText('Steps:<ol><li>sort</li><li>scan</li></ol>done')).toEqual(['Steps:', '1. sort', '2. scan', 'done']);
  });

  it('keeps one empty line for <br><br>, and drops empty lines at the start and end', () => {
    expect(htmlToLines('a<br><br>b')).toEqual([[txt('a')], [], [txt('b')]]);
    expect(htmlToLines('a<br><br><br><br>b')).toEqual([[txt('a')], [], [txt('b')]]);
    expect(htmlToLines('<br>a<br>')).toEqual([[txt('a')]]);
    expect(htmlToLines('<div><br></div>a')).toEqual([[txt('a')]]);
  });

  it('collapses white space in HTML like a browser (a "\\n" in HTML is a space)', () => {
    expect(htmlToLines('<div class="example">Wir haben   ein\n kleines Bad.</div>\n')).toEqual([
      [txt('Wir haben ein kleines Bad.')],
    ]);
    expect(htmlToLines('  <b> a </b>  ')).toEqual([[txt('a', { b: true })]]);
  });

  it('plain text (no tag at all) keeps its line breaks', () => {
    expect(htmlToLines('/ˈʃtʊndə/\nAn hour has 60 minutes.')).toEqual([
      [txt('/ˈʃtʊndə/')],
      [txt('An hour has 60 minutes.')],
    ]);
    expect(htmlToLines('a\r\nb\rc')).toEqual([[txt('a')], [txt('b')], [txt('c')]]);
    expect(htmlToLines('a < b and b > c')).toEqual([[txt('a < b and b > c')]]);
  });

  it('a "<" + letter that is not a real tag keeps the field plain (its line breaks stay)', () => {
    expect(htmlToLines('x<y\nz')).toEqual([[txt('x<y')], [txt('z')]]);
    expect(htmlToLines('if i<n:\n  return i')).toEqual([[txt('if i<n:')], [txt('return i')]]);
    expect(hasHtmlTags('if i<n:')).toBe(false);
    expect(hasHtmlTags('a<b>c</b>')).toBe(true);
    expect(hasHtmlTags('a<!-- note')).toBe(true);
    expect(hasHtmlTags('<br/>')).toBe(true);
  });

  it('<pre> keeps its line breaks and indentation (code in a Coding deck)', () => {
    expect(htmlToLines('<pre>def f():\n    return 1</pre>')).toEqual([[txt('def f():')], [txt('    return 1')]]);
    // Like a browser: the line break right after <pre> is not shown; text after </pre> is HTML again.
    expect(htmlToLines('Code:<pre>\nx  =  1\n<b>y</b> = 2\n</pre>after   this')).toEqual([
      [txt('Code:')],
      [txt('x  =  1')],
      [txt('y', { b: true }), txt(' = 2')],
      [txt('after this')],
    ]);
    // A line of only spaces is an empty line; a stray </pre> does nothing.
    expect(htmlToLines('<pre>a\n   \nb</pre></pre>c\nd')).toEqual([[txt('a')], [], [txt('b')], [txt('c d')]]);
  });

  it('empty input, white space and tags only → no lines', () => {
    expect(htmlToLines('')).toEqual([]);
    expect(htmlToLines('   \n ')).toEqual([]);
    expect(htmlToLines('<div></div><span> </span>')).toEqual([]);
  });
});

describe('styles', () => {
  it('b/strong, i/em, u, sub, sup', () => {
    expect(htmlToLines('a <b>b</b> <strong>s</strong> <i>i</i> <em>e</em> <u>u</u> H<sub>2</sub>O x<sup>2</sup>')).toEqual([
      [
        txt('a '),
        txt('b', { b: true }),
        txt(' '),
        txt('s', { b: true }),
        txt(' '),
        txt('i', { i: true }),
        txt(' '),
        txt('e', { i: true }),
        txt(' '),
        txt('u', { u: true }),
        txt(' H'),
        txt('2', { sub: true }),
        txt('O x'),
        txt('2', { sup: true }),
      ],
    ]);
  });

  it('nested styles add up; a style crosses a line break; a stray closing tag is ignored', () => {
    expect(htmlToLines('<b>bold <i>both</i></b>')).toEqual([[txt('bold ', { b: true }), txt('both', { b: true, i: true })]]);
    expect(htmlToLines('<b>one<br>two</b> three')).toEqual([[txt('one', { b: true })], [txt('two', { b: true }), txt(' three')]]);
    expect(htmlToLines('</b>plain<b/>')).toEqual([[txt('plain')]]);
  });

  it('tag names ignore case', () => {
    expect(htmlToLines('<B>x</B><BR><DIV>y</DIV>')).toEqual([[txt('x', { b: true })], [txt('y')]]);
  });
});

describe('images and sounds', () => {
  it('<img src> becomes an image inline (any quotes, entities decoded)', () => {
    expect(htmlToLines('<img src="example.webp">')).toEqual([[{ t: 'img', src: 'example.webp' }]]);
    expect(htmlToLines("<img alt='x' src='a b.png' />")).toEqual([[{ t: 'img', src: 'a b.png' }]]);
    expect(htmlToLines('<IMG SRC=bare.jpg>')).toEqual([[{ t: 'img', src: 'bare.jpg' }]]);
    expect(htmlToLines('<img src="x&amp;y.png">')).toEqual([[{ t: 'img', src: 'x&y.png' }]]);
    expect(htmlToLines('see <img src="d.png"> here')).toEqual([[txt('see '), { t: 'img', src: 'd.png' }, txt(' here')]]);
  });

  it('an <img> without a src is dropped', () => {
    expect(htmlToLines('<img><img src="">a')).toEqual([[txt('a')]]);
    expect(htmlToLines('<img data-src="x.png">a')).toEqual([[txt('a')]]);
    expect(htmlToLines('<img src="never closed>a')).toEqual([[txt('a')]]);
  });

  it('the src is read attribute by attribute: text inside another value is not the src', () => {
    expect(htmlToLines('<img alt="a src=evil.png" src="real.png">')).toEqual([[{ t: 'img', src: 'real.png' }]]);
    expect(htmlToLines("<img title='src=\"evil.png\"' SRC = ok.png>")).toEqual([[{ t: 'img', src: 'ok.png' }]]);
    expect(htmlToLines('<img alt="x"src="glued.png">')).toEqual([[{ t: 'img', src: 'glued.png' }]]);
    // Like a browser, the first src wins.
    expect(htmlToLines('<img src="first.png" src="second.png">')).toEqual([[{ t: 'img', src: 'first.png' }]]);
    expect(htmlToLines('<img src=a.png />')).toEqual([[{ t: 'img', src: 'a.png' }]]);
  });

  it('[sound:x] becomes a sound inline', () => {
    expect(htmlToLines('Haus [sound:haus.mp3]')).toEqual([[txt('Haus '), { t: 'sound', src: 'haus.mp3' }]]);
    expect(htmlToLines('[SOUND:a.mp3]')).toEqual([[{ t: 'sound', src: 'a.mp3' }]]);
    expect(htmlToLines('[sound:]')).toEqual([[txt('[sound:]')]]);
    expect(htmlToLines('[sound:a[b]')).toEqual([[txt('[sound:a[b]')]]);
    expect(htmlToLines('[note] text')).toEqual([[txt('[note] text')]]);
  });
});

describe('what is removed', () => {
  it('<script> and <style> are removed with their content', () => {
    expect(htmlToLines('a<script>alert("x<br>")</script>b')).toEqual([[txt('ab')]]);
    expect(htmlToLines('a<STYLE type="text/css">.x{color:red}</Style>b')).toEqual([[txt('ab')]]);
    expect(htmlToLines('a<script src="evil.js"></script>b')).toEqual([[txt('ab')]]);
  });

  it('an unclosed <script> drops everything after it', () => {
    expect(htmlToLines('safe<script>alert(1)<b>more</b>')).toEqual([[txt('safe')]]);
  });

  it('a <script>/<style> ends only at its OWN closing tag, not at "</scriptfoo>" or "</styles>" (like a browser)', () => {
    expect(htmlToLines('a<script>x</scriptfoo>b</script>c')).toEqual([[txt('ac')]]);
    expect(htmlToLines('a<style>x</styles>b</style>c')).toEqual([[txt('ac')]]);
    // The real end tag may be followed by '>', '/', white space or the end of the text.
    expect(htmlToLines('a<script>x</script >b')).toEqual([[txt('ab')]]);
    expect(htmlToLines('a<script>x</SCRIPT\n>b')).toEqual([[txt('ab')]]);
    expect(htmlToLines('a<script>x</script/>b')).toEqual([[txt('ab')]]);
    expect(htmlToLines('a<script>x</script')).toEqual([[txt('a')]]);
    // Only "</scriptfoo>": the script never ends, so the rest is dropped.
    expect(htmlToLines('a<script>x</scriptfoo>b')).toEqual([[txt('a')]]);
  });

  it('"<script/>" and "<style/>" are not closed by the "/" (a browser ignores it): their content is removed', () => {
    expect(htmlToLines('a<script/>alert(1)</script>b')).toEqual([[txt('ab')]]);
    expect(htmlToLines('a<style />.x{color:red}</style>b')).toEqual([[txt('ab')]]);
    expect(htmlToLines('a<script/>alert(1)')).toEqual([[txt('a')]]);
  });

  it('comments, doctype and processing instructions are removed', () => {
    expect(htmlToLines('a<!-- <b>hidden</b> -->b<!DOCTYPE html><?xml version="1.0"?>c')).toEqual([[txt('abc')]]);
    expect(htmlToLines('a<!-- never closed <b>x</b>')).toEqual([[txt('a')]]);
  });

  it('every other tag is dropped and its text kept', () => {
    expect(htmlToLines('<span style="color:red">red</span> <a href="javascript:x()">link</a> <code>x = 1</code> <font>f</font>')).toEqual([
      [txt('red link x = 1 f')],
    ]);
    expect(htmlToLines('<div onclick="steal()">click</div>')).toEqual([[txt('click')]]);
  });

  it('a "<" that does not start a tag stays as a character', () => {
    expect(htmlToLines('<b>a</b> 3 < 4')).toEqual([[txt('a', { b: true }), txt(' 3 < 4')]]);
    expect(htmlToLines('<i>x</i> a<<b>b</b>')).toEqual([[txt('x', { i: true }), txt(' a<'), txt('b', { b: true })]]);
    expect(htmlToLines('<i>x</i><never closed')).toEqual([[txt('x', { i: true }), txt('<never closed')]]);
  });
});

describe('entities', () => {
  it('decodes the anki.ts named entities and numeric entities', () => {
    expect(htmlToPlain('Tom &amp; Jerry &lt;3 &auml;&ouml;&uuml;&szlig; &#228; &#xE4; &#x1F600;')).toBe('Tom & Jerry <3 äöüß ä ä 😀');
  });

  it('decodes more entities that real decks use', () => {
    expect(htmlToPlain('O(n&sup2;) &times; &sum; &rarr; &frac12;')).toBe('O(n²) × ∑ → ½');
  });

  it('&nbsp; is a space; unknown entities stay as written', () => {
    expect(htmlToLines('a&nbsp;b')).toEqual([[txt('a b')]]);
    expect(htmlToPlain('&nosuchthing; &#0; & alone')).toBe('&nosuchthing; &#0; & alone');
  });

  it('an entity named like an Object member is text, not a crash (&constructor; &toString; &valueOf;)', () => {
    expect(htmlToPlain('a &constructor; &toString; &valueOf; &hasOwnProperty; b')).toBe(
      'a &constructor; &toString; &valueOf; &hasOwnProperty; b',
    );
    expect(htmlToLines('<b>x</b> &constructor;')).toEqual([[{ t: 'text', text: 'x', b: true }, txt(' &constructor;')]]);
  });

  it('a decoded "<" never becomes a tag', () => {
    expect(htmlToLines('&lt;script&gt;alert(1)&lt;/script&gt;')).toEqual([[txt('<script>alert(1)</script>')]]);
    expect(htmlToLines('&lt;b&gt;x')).toEqual([[txt('<b>x')]]);
  });
});

describe('plain text', () => {
  it('linesToPlain joins lines with a space and leaves out images and sounds', () => {
    expect(linesToPlain(htmlToLines('ich bin<br>du bist <img src="a.png">[sound:a.mp3]'))).toBe('ich bin du bist');
    expect(htmlToPlain('<ul><li>a</li><li>b</li></ul>')).toBe('• a • b');
    expect(htmlToPlain('')).toBe('');
  });

  it('keeps the characters that the made-up fixtures do not hold', () => {
    expect(htmlToPlain(RARE_CHARS)).toBe(RARE_CHARS);
    expect(htmlToPlain(`<b>${RARE_CHARS}</b>`)).toBe(RARE_CHARS);
    expect(stripHtml(RARE_CHARS)).toBe(RARE_CHARS);
  });

  it('on every field of the five deck fixtures, the plain text equals stripHtml (bullets and extra entities aside)', () => {
    // stripHtml does not know &times; &sum; &sup2; (the Coding deck uses them); htmlLines does.
    const moreEntities = (s: string) => s.replace(/&times;/g, '×').replace(/&sum;/g, '∑').replace(/&sup2;/g, '²');
    for (const name of ANKI_FIXTURES) {
      for (const note of ankiFixture(name).notes) {
        for (const value of note.flds.split('\x1f')) {
          const plain = htmlToPlain(value).replace(/• /g, '').replace(/\s+/g, ' ').trim();
          expect(plain).toBe(moreEntities(stripHtml(value)).replace(/•\s/g, '').replace(/\s+/g, ' ').trim());
        }
      }
    }
  });

  it('renders the Algo Deck fixture HTML (bold, lists, images) as lines', () => {
    const fx = ankiFixture('algo_patterns');
    const withImage = fx.notes.map((n) => n.flds.split('\x1f')[1]).find((v) => v.includes('<img'));
    expect(withImage).toBeDefined();
    const lines = htmlToLines(withImage ?? '');
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.flat().some((p) => p.t === 'img')).toBe(true);
    expect(lines.flat().some((p) => p.t === 'text' && p.b === true)).toBe(true);
  });
});

/*
 * Timing that a busy test machine cannot break (W4-7). A fixed "< 100 ms"
 * failed once at 122 ms while the machine was loaded, and passed on the
 * next run. So each guard now:
 *   - counts the CPU time of this test process (process.cpuUsage), not the
 *     wall clock: the time the process waits while other programs use the
 *     processor is not counted;
 *   - proves LINEAR time: 4 times the input must take less than 10 times as
 *     long. Linear work takes about 4 times as long (a little more on a
 *     busy memory cache), quadratic work about 16 times;
 *   - measures in TURNS (big, small, big, small …), so a moment of load
 *     touches both sizes, and keeps the fastest of 5 runs per size; each
 *     run repeats the call for at least 10 ms. Up to 3 tries: load can
 *     spoil one try, quadratic work fails every try;
 *   - keeps a fixed budget only as a very generous bound: the full-size
 *     input (the size the old guard used) in < 1 s.
 */
describe('linear time (a field can never freeze the app)', () => {
  /** The CPU time this process has used, in ms (the wall clock where `process.cpuUsage` is missing). */
  const clock = (): number => {
    if (typeof process !== 'undefined' && typeof process.cpuUsage === 'function') {
      const used = process.cpuUsage();
      return (used.user + used.system) / 1000;
    }
    return Date.now();
  };

  /** One run: the time of one htmlToLines(input) in ms, the call repeated for at least 10 ms. */
  const runMs = (input: string): number => {
    let calls = 0;
    let elapsed = 0;
    const start = clock();
    do {
      htmlToLines(input);
      calls += 1;
      elapsed = clock() - start;
    } while (elapsed < 10);
    return elapsed / calls;
  };

  /** Check make(n) → make(4n): growth < 10 ×, and the full size (make(4n)) in < 1 s. */
  const expectLinear = (make: (n: number) => string, n: number) => {
    const small = make(n);
    const big = make(4 * n);
    htmlToLines(small); // warm up
    htmlToLines(big);
    let best = { growth: Number.POSITIVE_INFINITY, bigMs: Number.POSITIVE_INFINITY };
    for (let attempt = 0; attempt < 3 && best.growth >= 10; attempt++) {
      let bigMs = Number.POSITIVE_INFINITY;
      let smallMs = Number.POSITIVE_INFINITY;
      for (let turn = 0; turn < 5; turn++) {
        bigMs = Math.min(bigMs, runMs(big));
        smallMs = Math.min(smallMs, runMs(small));
      }
      if (bigMs / smallMs < best.growth) best = { growth: bigMs / smallMs, bigMs };
    }
    expect(best.growth).toBeLessThan(10);
    expect(best.bigMs).toBeLessThan(1000);
  };

  it('200k "<" characters: linear, and read as plain text', () => {
    expectLinear((n) => '<'.repeat(n), 50_000);
    const input = '<'.repeat(200_000);
    expect(htmlToLines(input)).toEqual([[txt(input)]]);
  });

  // [label, input of size n, n]: the full-size input make(4 × n) is the one the old guard used.
  it.each<[string, (n: number) => string, number]>([
    ['"<a" with no ">"', (n) => '<a'.repeat(n), 25_000],
    ['"&" with no ";"', (n) => '&amp'.repeat(n), 12_500],
    ['"[sound:" with no "]"', (n) => '[sound:'.repeat(n), 7_500],
    ['unclosed comments', (n) => '<!--'.repeat(n), 12_500],
    ['unclosed scripts', (n) => '<script>'.repeat(n), 6_250],
    ['many tags', (n) => '<b>x</b><br>'.repeat(n), 5_000],
    ['"</" without a script end', (n) => `<script>${'</'.repeat(n)}`, 25_000],
    ['"</scriptx" that is not the end', (n) => `<script>${'</scriptx'.repeat(n)}`, 7_500],
    ['"<a" + long text with no ">"', (n) => `<a${'b'.repeat(n)}`, 50_000],
    ['an <img> with many attributes', (n) => `<img ${'alt="src=x" '.repeat(n)}src="y.png">`, 5_000],
    ['a long <pre> block', (n) => `<pre>${'  a\n'.repeat(n)}</pre>`, 12_500],
    ['a <pre> line of spaces', (n) => `<pre>${' '.repeat(n)}x</pre>`, 50_000],
  ])('%s: linear (4 × the input < 10 × the time), the full size in < 1 s', (_label, make, n) => {
    expectLinear(make, n);
  });
});
