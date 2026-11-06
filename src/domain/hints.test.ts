/**
 * Hints (spec §6.4, unit W4-4 / A3): the three steps and the example blanking.
 *
 *   tap 1  example with the answer blanked, else first letters + length mask
 *   tap 2  half of the letters
 *   tap 3  reveal
 */
import { describe, expect, it } from '@jest/globals';

import { FIXED_NOW } from '../test/clock';
import { makeNoteV3 } from '../test/factoriesV3';
import { builtinType } from './builtinTypes';
import type { NoteType } from './model';
import {
  BLANK,
  blankExample,
  HINT_STEPS,
  hintAt,
  hintSourceOf,
  letterMask,
  WORD_GAP,
  type HintSource,
} from './hints';
import { renderFace } from './render';

const src = (answer: string, examples: string[] = [], lang?: string): HintSource =>
  lang ? { answer, examples, lang } : { answer, examples };

describe('letterMask', () => {
  it("'first' keeps the first letter of each word and masks the rest", () => {
    expect(letterMask('go home', 'first')).toBe('g_ · h___');
    expect(letterMask('die Stunde', 'first')).toBe('d__ · S_____');
    expect(letterMask('Haus', 'first')).toBe('H___');
    expect(WORD_GAP).toBe(' · ');
  });

  it("'half' keeps every other letter (half, rounded up)", () => {
    expect(letterMask('go home', 'half')).toBe('g_ · h_m_');
    expect(letterMask('Stunde', 'half')).toBe('S_u_d_');
    expect(letterMask('Abfahrt', 'half')).toBe('A_f_h_t');
  });

  it('never hides punctuation, and collapses spaces', () => {
    expect(letterMask("don't", 'first')).toBe("d__'_");
    expect(letterMask('  to   go! ', 'first')).toBe('t_ · g_');
    expect(letterMask('well-known', 'first')).toBe('w___-_____');
  });

  it('hides digits and letters of any alphabet', () => {
    expect(letterMask('1984', 'first')).toBe('1___');
    expect(letterMask('привет', 'first')).toBe('п_____');
    expect(letterMask('你好', 'first')).toBe('你_');
  });
});

describe('blankExample', () => {
  it('blanks the answer in an example', () => {
    expect(blankExample(src('gehe', ['Ich gehe nach Hause.']))).toBe(`Ich ${BLANK} nach Hause.`);
    expect(BLANK).toBe('____');
  });

  it('compares folded (case, accents, ß) and keeps the rest of the sentence as it is', () => {
    expect(blankExample(src('über', ['Über die Brücke gehen.']))).toBe('____ die Brücke gehen.');
    expect(blankExample(src('Strasse', ['Die Straße ist lang.']))).toBe('Die ____ ist lang.');
    expect(blankExample(src('Straße', ['Die Strasse ist lang.']))).toBe('Die ____ ist lang.');
  });

  it('only whole words: "an" never blanks the inside of "kann"', () => {
    expect(blankExample(src('an', ['Ich kann es.']))).toBeNull();
    expect(blankExample(src('an', ['Ich kann an dich denken.']))).toBe('Ich kann ____ dich denken.');
  });

  it('blanks every place the answer appears', () => {
    expect(blankExample(src('nein', ['Nein, sagte er, nein!']))).toBe('____, sagte er, ____!');
    // A sentence that is only the answer, again and again, leaves nothing to read.
    expect(blankExample(src('nein', ['Nein, nein, nein!']))).toBeNull();
  });

  it('tries the alternatives of the answer', () => {
    expect(blankExample(src('to go, to walk', ['I want to walk home.']))).toBe('I want ____ home.');
  });

  it('a German noun: the whole term first, then the bare word', () => {
    expect(blankExample(src('die Stunde', ['Die Stunde ist um.'], 'de-DE'))).toBe('____ ist um.');
    expect(blankExample(src('die Stunde', ['Eine Stunde hat 60 Minuten.'], 'de-DE'))).toBe(
      'Eine ____ hat 60 Minuten.',
    );
    // Not German: the bare word is not tried.
    expect(blankExample(src('die Stunde', ['Eine Stunde hat 60 Minuten.']))).toBeNull();
  });

  it('a German "der/die X" answer blanks the noun, never only the articles', () => {
    const source = src('der/die Angestellte', ['Der Angestellte arbeitet in der Firma.'], 'de-DE');
    const blanked = blankExample(source);
    expect(blanked).toBe('____ arbeitet in der Firma.');
    expect(hintAt(source, 1)).toEqual({ step: 1, kind: 'example', text: '____ arbeitet in der Firma.' });
    // The other article, and the bare noun after another word.
    expect(blankExample(src('der/die Angestellte', ['Die Angestellte ist nett.'], 'de-DE'))).toBe('____ ist nett.');
    expect(blankExample(src('der/die Angestellte, -n', ['Eine Angestellte ruft an.'], 'de-DE'))).toBe('Eine ____ ruft an.');
    // An article written after the word ("Abfahrt, die") is not a needle either.
    expect(blankExample(src('Abfahrt, die', ['Die Abfahrt ist um acht.'], 'de-DE'))).toBe('Die ____ ist um acht.');
  });

  it('a Basic + reverse card in the English → German direction never shows the noun in its hint', () => {
    const base = builtinType('basicReverse', FIXED_NOW);
    const type: NoteType = {
      ...base,
      id: 'nt-de-reverse',
      fields: base.fields.map((f, i) => (i === 0 || i === 2 ? { ...f, lang: 'de-DE' } : f)),
    };
    const note = makeNoteV3({
      typeId: type.id,
      fields: ['der/die Angestellte', 'the employee', 'Der Angestellte arbeitet in der Firma.', ''],
    });
    const source = hintSourceOf(renderFace(note, type, 1)); // ord 1: Back → Front, the answer is German
    expect(source).toMatchObject({ answer: 'der/die Angestellte', lang: 'de-DE' });
    const hint = hintAt(source, 1);
    expect(hint).toMatchObject({ step: 1, kind: 'example' });
    expect(hint && hint.kind === 'example' ? hint.text : '').not.toContain('Angestellte');
  });

  it('a combining accent after the last letter is blanked with it', () => {
    expect(blankExample(src('uber', ['Er geht über die Straße.']))).toBe('Er geht ____ die Straße.');
  });

  it('null when no example has it, when the example is only the answer, or for one letter', () => {
    expect(blankExample(src('Haus', ['Ich gehe nach Hause.']))).toBeNull(); // "Hause" is not "Haus"
    expect(blankExample(src('Haus', ['Haus.']))).toBeNull();
    expect(blankExample(src('a', ['a cat']))).toBeNull();
    expect(blankExample(src('Haus', []))).toBeNull();
  });

  it('uses the first example that contains the answer', () => {
    expect(blankExample(src('Hund', ['Die Katze schläft.', 'Der Hund bellt.']))).toBe('Der ____ bellt.');
  });

  it('scripts without upper and lower case: the example is blanked too (spec §6.4)', () => {
    // Japanese and Chinese write no spaces between words: the answer stands inside the sentence.
    expect(blankExample(src('食べる', ['毎日パンを食べる。'], 'ja-JP'))).toBe('毎日パンを____。');
    expect(blankExample(src('喜欢', ['我喜欢猫。'], 'zh-CN'))).toBe('我____猫。');
    // Thai has no spaces between words either.
    expect(blankExample(src('แมว', ['ฉันชอบแมว'], 'th-TH'))).toBe('ฉันชอบ____');
    // Arabic and Hebrew: words between spaces, and also with a joined small word (the article "ال").
    expect(blankExample(src('كتاب', ['هذا كتاب جميل.'], 'ar'))).toBe('هذا ____ جميل.');
    expect(blankExample(src('كتاب', ['قرأت الكتاب.'], 'ar'))).toBe('قرأت ال____.');
    expect(blankExample(src('ספר', ['זה ספר טוב.'], 'he'))).toBe('זה ____ טוב.');
    // So step 1 is the example, not the letter mask.
    expect(hintAt(src('食べる', ['毎日パンを食べる。'], 'ja-JP'), 1)).toEqual({ step: 1, kind: 'example', text: '毎日パンを____。' });
  });

  it('scripts without case keep the other rules: 2 characters at least, and something left to read', () => {
    // One character would blank too much (the same rule as "a").
    expect(blankExample(src('猫', ['猫が好きです。'], 'ja-JP'))).toBeNull();
    // A sentence that is only the answer and its punctuation is no hint.
    expect(blankExample(src('食べる', ['食べる。'], 'ja-JP'))).toBeNull();
    expect(blankExample(src('كتاب', ['كتاب؟'], 'ar'))).toBeNull();
    // Full-width punctuation is never hidden by a mask either.
    expect(letterMask('食べる、飲む', 'first')).toBe('食__、__');
  });

  it('Arabic and Hebrew: never INSIDE a different word; only a known prefix may come before the answer (W4-7 review round 1)', () => {
    // "كتب" (he wrote) inside "المكتبة" (the library) is another word: no example hint, the letter mask instead.
    expect(blankExample(src('كتب', ['المكتبة كبيرة.'], 'ar'))).toBeNull();
    expect(hintAt(src('كتب', ['المكتبة كبيرة.'], 'ar'), 1)).toEqual({ step: 1, kind: 'letters', text: letterMask('كتب', 'first') });
    // The answer must END at a word end: "كتاب" in "كتابي" (my book) is not blanked.
    expect(blankExample(src('كتاب', ['هذا كتابي.'], 'ar'))).toBeNull();
    // The known prefixes before it are fine: ال (the), و (and), ب (with), بال, وال, لل.
    expect(blankExample(src('كتاب', ['قرأت الكتاب.'], 'ar'))).toBe('قرأت ال____.');
    expect(blankExample(src('كتاب', ['قلم وكتاب.'], 'ar'))).toBe('قلم و____.');
    expect(blankExample(src('كتاب', ['كتبت بالكتاب.'], 'ar'))).toBe('كتبت بال____.');
    // W5-5a: the longest prefixes have 4 letters ("و" / "ف" + "بال" / "كال"); the walk back stopped at 3.
    expect(blankExample(src('كتاب', ['أكتب وبالكتاب.'], 'ar'))).toBe('أكتب وبال____.');
    expect(blankExample(src('كتاب', ['فبالكتاب نتعلم.'], 'ar'))).toBe('فبال____ نتعلم.');
    expect(blankExample(src('كتاب', ['وكالكتاب هذا.'], 'ar'))).toBe('وكال____ هذا.');
    // Five letters before it are never a prefix: "كتاب" inside a longer word stays.
    expect(blankExample(src('كتاب', ['قرأت مالبالكتاب.'], 'ar'))).toBeNull();
    // Hebrew: "ספר" (book) inside "מספר" (number) is another word; "בספר" (in a book) is the answer.
    expect(blankExample(src('ספר', ['זה מספר גדול.'], 'he'))).toBeNull();
    expect(blankExample(src('ספר', ['זה ספרים.'], 'he'))).toBeNull(); // must end at a word end
    expect(blankExample(src('ספר', ['קראתי בספר.'], 'he'))).toBe('קראתי ב____.');
    expect(blankExample(src('ספר', ['ספר והספר.'], 'he'))).toBe('____ וה____.'); // "וה" = and + the
    // The punctuation of these scripts ends a word (it is no letter): the Arabic comma and question mark, the Urdu full stop.
    expect(blankExample(src('كتاب', ['كتاب، قلم.'], 'ar'))).toBe('____، قلم.');
    expect(blankExample(src('كتاب', ['هل هذا كتاب؟'], 'ar'))).toBe('هل هذا ____؟');
    expect(blankExample(src('کتاب', ['یہ کتاب ہے۔'], 'ur'))).toBe('یہ ____ ہے۔');
    expect(blankExample(src('ספר', ['בית־ספר גדול.'], 'he'))).toBe('בית־____ גדול.'); // "־" joins two words
  });

  it('Korean: the answer starts a word, and its particles may follow it', () => {
    expect(blankExample(src('사과', ['사과를 먹어요.'], 'ko'))).toBe('____를 먹어요.');
    expect(blankExample(src('사과', ['저는 사과 좋아요.'], 'ko'))).toBe('저는 ____ 좋아요.');
    // "고기" (meat) inside "물고기" (fish) is another word.
    expect(blankExample(src('고기', ['물고기를 봐요.'], 'ko'))).toBeNull();
  });

  it('other spaced scripts without case keep the whole-word rule (Hindi)', () => {
    expect(blankExample(src('किताब', ['यह किताब है।'], 'hi'))).toBe('यह ____ है।');
    expect(blankExample(src('किताब', ['यह किताबें हैं।'], 'hi'))).toBeNull(); // inside "किताबें" (books)
    // The full stop "।" ends the word, and a mask never hides it.
    expect(blankExample(src('किताब', ['मेरी किताब।'], 'hi'))).toBe('मेरी ____।');
    expect(letterMask('किताब।', 'first')).toBe('क____।');
  });

  it('scripts WITH case keep the whole-word rule (Cyrillic, Greek)', () => {
    expect(blankExample(src('кот', ['Это котёнок.']))).toBeNull(); // inside "котёнок"
    expect(blankExample(src('кот', ['Это мой кот.']))).toBe('Это мой ____.');
    expect(blankExample(src('σπίτι', ['Το σπίτι είναι μεγάλο.']))).toBe('Το ____ είναι μεγάλο.');
  });
});

describe('hintAt: the three steps', () => {
  const withExample = src('gehe', ['Ich gehe nach Hause.']);
  const noExample = src('go home');

  it('step 1: the blanked example when there is one, else the first letters', () => {
    expect(hintAt(withExample, 1)).toEqual({ step: 1, kind: 'example', text: 'Ich ____ nach Hause.' });
    expect(hintAt(noExample, 1)).toEqual({ step: 1, kind: 'letters', text: 'g_ · h___' });
  });

  it('step 2: half of the letters (also after an example)', () => {
    expect(hintAt(noExample, 2)).toEqual({ step: 2, kind: 'letters', text: 'g_ · h_m_' });
    expect(hintAt(withExample, 2)).toEqual({ step: 2, kind: 'letters', text: 'g_h_' });
  });

  it('step 3 (and more): reveal', () => {
    expect(HINT_STEPS).toBe(3);
    expect(hintAt(noExample, 3)).toEqual({ step: 3, kind: 'reveal' });
    expect(hintAt(noExample, 7)).toEqual({ step: 3, kind: 'reveal' });
  });

  it('no tap yet → no hint', () => {
    expect(hintAt(noExample, 0)).toBeNull();
    expect(hintAt(noExample, -1)).toBeNull();
    expect(hintAt(noExample, Number.NaN)).toBeNull();
  });

  it('an answer with nothing to hide (an image only) reveals at once', () => {
    expect(hintAt(src(''), 1)).toEqual({ step: 3, kind: 'reveal' });
    expect(hintAt(src('?!'), 1)).toEqual({ step: 3, kind: 'reveal' });
  });
});

describe('hintSourceOf', () => {
  it('the answer, the answer-side examples and the answer language of a face', () => {
    const type = builtinType('legacyVocabDe', FIXED_NOW);
    const note = makeNoteV3({
      typeId: type.id,
      fields: ['gehen', 'to go', 'Ich gehe nach Hause.', 'I go home.', '', 'A1', 'verb', '', '', ''],
    });
    const face = renderFace(note, type, 0);
    expect(hintSourceOf(face)).toEqual({ answer: 'to go', examples: ['Ich gehe nach Hause.'], lang: 'en-US' });
  });

  it('skips empty examples, and takes the typing target when given', () => {
    const type = builtinType('basic', FIXED_NOW);
    const note = makeNoteV3({ typeId: type.id, fields: ['die Stunde', 'the hour', '', 'a note'] });
    const face = renderFace(note, type, 0);
    expect(hintSourceOf(face)).toEqual({ answer: 'the hour', examples: [] });
    expect(hintSourceOf(face, 'die Stunde', 'de-DE')).toEqual({ answer: 'die Stunde', examples: [], lang: 'de-DE' });
  });

  it('a cloze card hints at the deletion, not the whole sentence', () => {
    const type = builtinType('cloze', FIXED_NOW);
    const note = makeNoteV3({ typeId: type.id, fields: ['The capital is {{c1::Paris}}.', ''] });
    const source = hintSourceOf(renderFace(note, type, 0));
    expect(source.answer).toBe('Paris');
    expect(hintAt(source, 1)).toEqual({ step: 1, kind: 'letters', text: 'P____' });
  });
});
