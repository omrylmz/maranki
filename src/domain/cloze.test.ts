/**
 * The one cloze parser (cloze.ts, unit H3). The load-bearing properties:
 *   - card numbers are 1 or more: {{c0::…}} makes no card, so no ord is
 *     ever below 0, and it shows as plain text;
 *   - {{c1,2::…}} belongs to cards 1 AND 2;
 *   - hints follow Anki's rule (each own text piece is cut at its first "::",
 *     the last hint wins); nested deletions, unclosed markup and stray "}}"
 *     follow fixed rules;
 *   - every card number found can be hidden by clozeSide (the round trip the
 *     card makers depend on);
 *   - linear time on hostile input.
 */
import { describe, expect, it } from '@jest/globals';

import {
  clozeAnswers,
  clozeNumbers,
  clozeSide,
  hasCloze,
  MAX_CLOZE_DEPTH,
  MAX_CLOZE_NUMBER,
  parseCloze,
  unwrapCloze,
} from './cloze';
import { createRandom } from '../test/random';

describe('parseCloze', () => {
  it('splits text and deletions; text without markup is one piece', () => {
    expect(parseCloze('{{c1::Paris}} is nice')).toEqual([
      { t: 'cloze', nums: [1], nodes: [{ t: 'text', text: 'Paris' }] },
      { t: 'text', text: ' is nice' },
    ]);
    expect(parseCloze('no cloze')).toEqual([{ t: 'text', text: 'no cloze' }]);
    expect(parseCloze('')).toEqual([]);
    expect(parseCloze(undefined as unknown as string)).toEqual([]);
  });

  it('a hint is the text after the first "::"', () => {
    expect(parseCloze('{{c2::France::country}}')).toEqual([
      { t: 'cloze', nums: [2], nodes: [{ t: 'text', text: 'France' }], hint: 'country' },
    ]);
    expect(parseCloze('{{c1::a::b::c}}')[0]).toMatchObject({ nodes: [{ t: 'text', text: 'a' }], hint: 'b::c' });
    // An empty answer with a hint: no text piece is left.
    expect(parseCloze('{{c1::::only a hint}}')[0]).toEqual({ t: 'cloze', nums: [1], nodes: [], hint: 'only a hint' });
  });

  it('{{c1,2::…}} belongs to both cards; numbers are sorted and not repeated', () => {
    expect(parseCloze('{{c2,1,2::x}}')[0]).toMatchObject({ nums: [1, 2] });
  });

  it('{{c0::…}} is a deletion of no card; a number above 65,535 is dropped', () => {
    expect(parseCloze('{{c0::x}}')).toEqual([{ t: 'cloze', nums: [], nodes: [{ t: 'text', text: 'x' }] }]);
    expect(parseCloze('{{c0,2::x}}')[0]).toMatchObject({ nums: [2] });
    expect(parseCloze('{{c65535::x}}')[0]).toMatchObject({ nums: [65535] });
    expect(parseCloze('{{c99999,3::x}}')[0]).toMatchObject({ nums: [3] });
    // Leading zeros are fine ("007" is 7), as when Anki reads the number.
    expect(parseCloze('{{c007::x}}')[0]).toMatchObject({ nums: [7] });
    // No number left at all: plain text, like Anki.
    expect(parseCloze('{{c99999::x}}')).toEqual([{ t: 'text', text: '{{c99999::x}}' }]);
  });

  it('nested deletions; the hint of the outer one comes after the inner one', () => {
    expect(parseCloze('{{c1::a {{c2::b}} c::hint}}')).toEqual([
      {
        t: 'cloze',
        nums: [1],
        nodes: [
          { t: 'text', text: 'a ' },
          { t: 'cloze', nums: [2], nodes: [{ t: 'text', text: 'b' }] },
          { t: 'text', text: ' c' },
        ],
        hint: 'hint',
      },
    ]);
  });

  it('a hint BEFORE a nested deletion is read like Anki: each own text piece is cut at its first "::"', () => {
    // Anki (rslib cloze.rs) cuts every text piece of the open deletion; the tail is the hint.
    const text = '{{c1::a::h {{c2::b}}}}';
    expect(parseCloze(text)).toEqual([
      {
        t: 'cloze',
        nums: [1],
        nodes: [
          { t: 'text', text: 'a' },
          { t: 'cloze', nums: [2], nodes: [{ t: 'text', text: 'b' }] },
        ],
        hint: 'h ',
      },
    ]);
    // Card 1 asks with its hint; card 2 never shows the raw "::h".
    expect(clozeSide(text, 1, 'prompt')).toBe('<b>[h ]</b>');
    expect(clozeSide(text, 2, 'prompt')).toBe('a<b>[…]</b>');
    expect(clozeSide(text, 2, 'answer')).toBe('a<b>b</b>');
    expect(clozeAnswers(text, 1)).toEqual(['ab']);
    expect(unwrapCloze(text)).toBe('ab');

    // Two own pieces with "::": the LAST one gives the hint, and neither tail is shown.
    const two = '{{c1::a::h1 {{c2::b}} c::h2}}';
    expect(parseCloze(two)[0]).toMatchObject({
      nodes: [{ t: 'text', text: 'a' }, { t: 'cloze', nums: [2] }, { t: 'text', text: ' c' }],
      hint: 'h2',
    });
    expect(clozeSide(two, 1, 'prompt')).toBe('<b>[h2]</b>');
    expect(clozeSide(two, 2, 'prompt')).toBe('a<b>[…]</b> c');
    // A "::" inside the NESTED deletion is the nested deletion's hint, not the outer one's.
    expect(parseCloze('{{c1::a {{c2::b::inner}} c}}')[0]).not.toHaveProperty('hint');
    expect(clozeSide('{{c1::a {{c2::b::inner}} c}}', 2, 'prompt')).toBe('a <b>[inner]</b> c');
  });

  it('markup that is not a deletion stays as written', () => {
    for (const text of [
      '{{cx::no}}', // no number
      '{{c::no}}',
      '{{c1, 2::spaces}}', // Anki joins numbers with "," only
      '{{c1,::x}}',
      '{{c1:x}}',
      '{{cat}}',
      '{{c3::never closed',
      'stray }} close',
      '{{{c', // a "{{c" at the very end
    ]) {
      expect(unwrapCloze(text)).toBe(text);
      expect(hasCloze(text)).toBe(false);
      expect(clozeNumbers(text)).toEqual([]);
    }
  });

  it('an unclosed start is text, and the "}}" goes to the innermost OPEN deletion', () => {
    // c1 never closes: it is text; c2 is a real deletion.
    expect(parseCloze('{{c1::a {{c2::b}}')).toEqual([
      { t: 'text', text: '{{c1::a ' },
      { t: 'cloze', nums: [2], nodes: [{ t: 'text', text: 'b' }] },
    ]);
    // A second "}}" with nothing open is text.
    expect(parseCloze('{{c1::a}} b}}')).toEqual([
      { t: 'cloze', nums: [1], nodes: [{ t: 'text', text: 'a' }] },
      { t: 'text', text: ' b}}' },
    ]);
    // "{{{c1::x}}}": the extra braces are text around the deletion.
    expect(unwrapCloze('{{{c1::x}}}')).toBe('{x}');
  });

  it(`at most ${MAX_CLOZE_DEPTH} levels; deeper markup is text (the recursion stays small)`, () => {
    const depth = MAX_CLOZE_DEPTH + 5;
    const text = `${'{{c1::'.repeat(depth)}x${'}}'.repeat(depth)}`;
    let level = 0;
    let nodes = parseCloze(text);
    while (nodes.length > 0 && nodes[0].t === 'cloze') {
      level += 1;
      nodes = nodes[0].nodes;
    }
    expect(level).toBe(MAX_CLOZE_DEPTH);
    // The deeper starts are text inside the deepest deletion, and every side still renders.
    expect(nodes[0]).toMatchObject({ t: 'text' });
    expect((nodes[0] as { text: string }).text.startsWith('{{c1')).toBe(true);
    expect(clozeSide(text, 1, 'prompt')).toBe(`<b>[…]</b>${'}}'.repeat(depth - MAX_CLOZE_DEPTH)}`);
  });
});

describe('clozeNumbers', () => {
  it('distinct and ascending; 0 is never a card number', () => {
    expect(clozeNumbers('{{c2::b}} {{c1::a}} {{c2::c}}')).toEqual([1, 2]);
    expect(clozeNumbers('{{c1,3::Paris}}')).toEqual([1, 3]);
    expect(clozeNumbers('{{c0::x}} {{c1::y}}')).toEqual([1]);
    expect(clozeNumbers('{{c0::x}}')).toEqual([]);
    expect(clozeNumbers('{{c1::a {{c4::b}}}}')).toEqual([1, 4]);
  });
});

describe('clozeSide and clozeAnswers', () => {
  const text = '{{c1::Paris}} is in {{c2::France::country}}';

  it('the prompt hides the deletions of card k; the answer shows them in bold', () => {
    expect(clozeSide(text, 1, 'prompt')).toBe('<b>[…]</b> is in France');
    expect(clozeSide(text, 2, 'prompt')).toBe('Paris is in <b>[country]</b>');
    expect(clozeSide(text, 2, 'answer')).toBe('Paris is in <b>France</b>');
    expect(clozeAnswers(text, 2)).toEqual(['France']);
  });

  it('a multi-number deletion is hidden on each of its cards', () => {
    const multi = '{{c1,2::Paris}} and {{c2::Rome}}';
    expect(clozeSide(multi, 1, 'prompt')).toBe('<b>[…]</b> and Rome');
    expect(clozeSide(multi, 2, 'prompt')).toBe('<b>[…]</b> and <b>[…]</b>');
    expect(clozeAnswers(multi, 2)).toEqual(['Paris', 'Rome']);
  });

  it('{{c0::…}} shows its answer as plain text on every card', () => {
    const zero = '{{c0::Berlin}} and {{c1::Paris}}';
    expect(clozeSide(zero, 1, 'prompt')).toBe('Berlin and <b>[…]</b>');
    expect(clozeSide(zero, 1, 'answer')).toBe('Berlin and <b>Paris</b>');
    expect(clozeAnswers(zero, 1)).toEqual(['Paris']);
  });

  it('nested: the outer card hides everything; the inner card hides only its part', () => {
    const nested = '{{c1::a {{c2::b}} c}}';
    expect(clozeSide(nested, 1, 'prompt')).toBe('<b>[…]</b>');
    expect(clozeSide(nested, 2, 'prompt')).toBe('a <b>[…]</b> c');
    expect(clozeSide(nested, 1, 'answer')).toBe('<b>a b c</b>');
    expect(clozeSide(nested, 2, 'answer')).toBe('a <b>b</b> c');
    expect(clozeAnswers(nested, 1)).toEqual(['a b c']);
    expect(clozeAnswers(nested, 2)).toEqual(['b']);
  });

  it('keeps text that is not a deletion exactly as written', () => {
    const mixed = '{{c2::b}} {{c1::a::hint}} {{c2::c}} {{cx::no}} {{c3::open';
    expect(clozeSide(mixed, 1, 'prompt')).toBe('b <b>[hint]</b> c {{cx::no}} {{c3::open');
    expect(clozeSide(mixed, 2, 'answer')).toBe('<b>b</b> a <b>c</b> {{cx::no}} {{c3::open');
  });

  it('plain text keeps its line breaks as <br>; HTML is left as it is', () => {
    expect(clozeSide('ich {{c1::bin}}\ndu bist', 1, 'prompt')).toBe('ich <b>[…]</b><br>du bist');
    expect(clozeSide('<i>ich</i> {{c1::bin}}\ndu', 1, 'prompt')).toBe('<i>ich</i> <b>[…]</b>\ndu');
  });

  it('unwrapCloze replaces every deletion by its answer (for search text)', () => {
    expect(unwrapCloze('{{c1::Berlin::capital}} is in {{c2,3::Germany}}')).toBe('Berlin is in Germany');
    expect(unwrapCloze('{{c1::a {{c2::b}} c}}')).toBe('a b c');
  });
});

describe('round trip: every card number found can be hidden (seeded random texts)', () => {
  /** A random cloze text: numbers 0–4, some multi-number, hints, nesting, stray markup. */
  function randomText(seed: number): string {
    const rnd = createRandom(`cloze-${seed}`);
    const piece = (depth: number): string => {
      const roll = rnd.int(0, 9);
      if (roll <= 3 || depth >= 3) return rnd.pick(['word', ' ', 'x y', '}}', '{{c', ':', '::', '{{cx::']);
      const nums = rnd.sample([0, 1, 2, 3, 4], rnd.int(1, 2)).join(',');
      const inner = Array.from({ length: rnd.int(1, 3) }, () => piece(depth + 1)).join('');
      const hint = rnd.bool(0.3) ? `::h${rnd.int(1, 9)}` : '';
      return rnd.bool(0.1) ? `{{c${nums}::${inner}` : `{{c${nums}::${inner}${hint}}}`;
    };
    return Array.from({ length: rnd.int(1, 5) }, () => piece(0)).join('');
  }

  it('each number gives a prompt with a hidden part, and the answer shows that part in bold (300 texts)', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const text = randomText(seed);
      for (const k of clozeNumbers(text)) {
        expect(k).toBeGreaterThanOrEqual(1);
        const prompt = clozeSide(text, k, 'prompt');
        if (!/<b>\[[^\]]*\]<\/b>/.test(prompt)) throw new Error(`seed ${seed}: card ${k} hides nothing in ${JSON.stringify(text)}`);
        expect(clozeAnswers(text, k).length).toBeGreaterThan(0);
        expect(clozeSide(text, k, 'answer')).toContain('<b>');
      }
    }
  });
});

/*
 * Timing that a busy test machine cannot break (W4-7). A fixed "< 100 ms"
 * failed once at 125 ms while the machine was loaded (load average 37) and
 * passed on the next run. So each guard now:
 *   - counts the CPU time of this test process (process.cpuUsage), not the
 *     wall clock: the time the process waits while other programs use the
 *     processor is not counted;
 *   - proves LINEAR time by comparing an input with one 4 times as big:
 *     linear work takes about 4 times as long, quadratic work about 16
 *     times. "Less than 10 times" is far from both (a big input also suffers
 *     a little more from a busy memory cache), and catches anything quadratic;
 *   - measures in TURNS (big, small, big, small …), so a moment of load
 *     touches both sizes, and keeps the fastest run of each size. Each run
 *     repeats the call for at least 10 ms. Up to 3 tries: load can spoil
 *     one try, quadratic work fails every try;
 *   - keeps a fixed budget only as a very generous upper bound (1 s for the
 *     full-size input; the real time is a few ms).
 */

/** The CPU time this process has used, in ms (the wall clock where `process.cpuUsage` is missing). */
const clockMs = (): number => {
  if (typeof process !== 'undefined' && typeof process.cpuUsage === 'function') {
    const used = process.cpuUsage();
    return (used.user + used.system) / 1000;
  }
  return Date.now();
};

/** At most this many times longer for 4 times the input: linear ≈ 4, quadratic ≈ 16. */
const MAX_GROWTH = 10;

/** The generous upper bound for the full-size input, in ms. */
const MAX_FULL_MS = 1000;

/** One run: the time of one call of `fn` in ms, with the call repeated for at least 10 ms. */
function runMs(fn: () => void): number {
  let calls = 0;
  let elapsed = 0;
  const start = clockMs();
  do {
    fn();
    calls += 1;
    elapsed = clockMs() - start;
  } while (elapsed < 10);
  return elapsed / calls;
}

/**
 * The time of `fn` on `big` (4 × the size of `small`) in ms, and how many
 * times longer that is than on `small` (see the comment above: turns, the
 * fastest run of 5 per size, up to 3 tries).
 */
function scaling(fn: (input: string) => unknown, small: string, big: string): { growth: number; bigMs: number } {
  fn(small); // warm up
  fn(big);
  let best = { growth: Number.POSITIVE_INFINITY, bigMs: Number.POSITIVE_INFINITY };
  for (let attempt = 0; attempt < 3 && best.growth >= MAX_GROWTH; attempt++) {
    let bigMs = Number.POSITIVE_INFINITY;
    let smallMs = Number.POSITIVE_INFINITY;
    for (let turn = 0; turn < 5; turn++) {
      bigMs = Math.min(bigMs, runMs(() => fn(big)));
      smallMs = Math.min(smallMs, runMs(() => fn(small)));
    }
    if (bigMs / smallMs < best.growth) best = { growth: bigMs / smallMs, bigMs };
  }
  return best;
}

describe('linear time (a field can never freeze the app)', () => {
  // [label, input of size n, n]: the full-size input is make(4 × n), the size the old guard used.
  const numbersUpTo = (n: number) => Array.from({ length: n }, (_, i) => i + 1).join(',');
  it.each<[string, (n: number) => string, number]>([
    ['50k starts with no "}}"', (n) => '{{c1::'.repeat(n), 12_500],
    ['50k "}}" with nothing open', (n) => '}}'.repeat(n), 12_500],
    ['deep nesting', (n) => `${'{{c1::'.repeat(n)}x${'}}'.repeat(n)}`, 5_000],
    ['"{{c" with long digit runs and no "::"', (n) => `{{c${'1,'.repeat(n)}x`, 12_500],
    // Many DIFFERENT numbers in one opener: the repeat check must not search a list
    // (that was O(k²): about 320 ms in Node for every number 1 … 65,535).
    ['one opener with every card number 1 … 65,535', (n) => `{{c${numbersUpTo(n)}::x}}`, Math.floor(MAX_CLOZE_NUMBER / 4)],
    ['many small deletions', (n) => '{{c1::a}} {{c2::b::h}} '.repeat(n), 2_500],
  ])('%s: linear (4 × the input takes < 10 × the time), the full size well under a second', (_label, make, n) => {
    const small = make(n);
    const big = make(4 * n);
    for (const fn of [(input: string) => clozeNumbers(input), (input: string) => clozeSide(input, 1, 'prompt')]) {
      const { growth, bigMs } = scaling(fn, small, big);
      expect(growth).toBeLessThan(MAX_GROWTH);
      expect(bigMs).toBeLessThan(MAX_FULL_MS);
    }
  });

  it('the guard itself catches quadratic work (so a pass really means linear)', () => {
    // A deliberately quadratic scan: for every character, look at every character before it.
    const quadratic = (input: string) => {
      let hits = 0;
      for (let i = 0; i < input.length; i++) for (let j = 0; j < i; j++) if (input.charCodeAt(j) === input.charCodeAt(i)) hits++;
      return hits;
    };
    expect(scaling(quadratic, 'ab'.repeat(600), 'ab'.repeat(2_400)).growth).toBeGreaterThan(MAX_GROWTH);
  });
});
