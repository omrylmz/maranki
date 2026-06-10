/**
 * Sample shared-deck payloads for the import hub. Until the real AnkiWeb
 * fetch + .apkg parser land (WIRING.md §5 backend work), choosing a shared
 * deck imports one of these small real payloads — the flow genuinely writes
 * cards, preserves the SRS fields it carries, and dedupes against the
 * library, so "Go study" lands in a real session.
 */
import { Card, DAY } from './types';

export type ImportCardPayload = Pick<Card, 'word' | 'tr'> & Partial<Card>;

export interface SharedDeck {
  id: string;
  name: string;
  cards: number;
  cat: string;
  by: string;
  flag: string;
  lang: string;
  payload: ImportCardPayload[];
}

const now = () => Date.now();

const GOETHE_A1: ImportCardPayload[] = [
  { word: 'das Haus', tr: 'the house', ipa: '/haʊ̯s/', ex: 'Das Haus ist alt.', exTr: 'The house is old.', level: 'A1', type: 'noun', lang: 'de' },
  { word: 'die Stadt', tr: 'the city', ipa: '/ʃtat/', ex: 'Die Stadt ist groß.', exTr: 'The city is big.', level: 'A1', type: 'noun', lang: 'de' },
  { word: 'trinken', tr: 'to drink', ipa: '/ˈtʁɪŋkn̩/', ex: 'Ich trinke Wasser.', exTr: 'I drink water.', level: 'A1', type: 'verb', lang: 'de' },
  { word: 'essen', tr: 'to eat', ipa: '/ˈɛsn̩/', ex: 'Wir essen zusammen.', exTr: 'We eat together.', level: 'A1', type: 'verb', lang: 'de' },
  { word: 'das Wasser', tr: 'the water', ipa: '/ˈvasɐ/', ex: 'Das Wasser ist kalt.', exTr: 'The water is cold.', level: 'A1', type: 'noun', lang: 'de' },
  { word: 'gut', tr: 'good', ipa: '/ɡuːt/', ex: 'Das ist eine gute Idee.', exTr: 'That is a good idea.', level: 'A1', type: 'adjective', lang: 'de' },
  { word: 'klein', tr: 'small', ipa: '/klaɪ̯n/', ex: 'Ein kleines Geschenk.', exTr: 'A small gift.', level: 'A1', type: 'adjective', lang: 'de' },
  { word: 'der Name', tr: 'the name', ipa: '/ˈnaːmə/', ex: 'Wie ist Ihr Name?', exTr: 'What is your name?', level: 'A1', type: 'noun', lang: 'de' },
  { word: 'heißen', tr: 'to be called', ipa: '/ˈhaɪ̯sn̩/', ex: 'Ich heiße Anna.', exTr: 'My name is Anna.', level: 'A1', type: 'verb', lang: 'de' },
  { word: 'die Antwort', tr: 'the answer', ipa: '/ˈantvɔʁt/', ex: 'Die Antwort ist richtig.', exTr: 'The answer is correct.', level: 'A1', type: 'noun', lang: 'de' },
];

/* a few cards arrive with preserved Anki scheduling — ease/interval/due */
const TOP4000: ImportCardPayload[] = [
  { word: 'die Entwicklung', tr: 'the development', ipa: '/ɛntˈvɪklʊŋ/', ex: 'Die Entwicklung dauert Jahre.', exTr: 'The development takes years.', level: 'B2', type: 'noun', lang: 'de', ease: 2.36, intervalDays: 12, reps: 6, due: now() + 4 * DAY, lastReviewedAt: now() - 8 * DAY, stepIndex: null },
  { word: 'die Gesellschaft', tr: 'the society, company', ipa: '/ɡəˈzɛlʃaft/', ex: 'Die Gesellschaft verändert sich.', exTr: 'Society is changing.', level: 'B2', type: 'noun', lang: 'de', ease: 2.5, intervalDays: 30, reps: 9, due: now() + 11 * DAY, lastReviewedAt: now() - 19 * DAY, stepIndex: null },
  { word: 'beeinflussen', tr: 'to influence', ipa: '/bəˈʔaɪ̯nflʊsn̩/', ex: 'Werbung beeinflusst uns alle.', exTr: 'Advertising influences us all.', level: 'B2', type: 'verb', lang: 'de', ease: 2.2, intervalDays: 5, reps: 4, due: now() - DAY, lastReviewedAt: now() - 6 * DAY, stepIndex: null },
  { word: 'die Wissenschaft', tr: 'the science', ipa: '/ˈvɪsn̩ʃaft/', ex: 'Die Wissenschaft sucht Antworten.', exTr: 'Science seeks answers.', level: 'B1', type: 'noun', lang: 'de' },
  { word: 'erreichen', tr: 'to reach, achieve', ipa: '/ɛɐ̯ˈʁaɪ̯çn̩/', ex: 'Wir haben unser Ziel erreicht.', exTr: 'We reached our goal.', level: 'B1', type: 'verb', lang: 'de' },
  { word: 'der Zustand', tr: 'the condition, state', ipa: '/ˈt͡suːʃtant/', ex: 'Der Zustand ist stabil.', exTr: 'The condition is stable.', level: 'B2', type: 'noun', lang: 'de' },
  { word: 'die Bedeutung', tr: 'the meaning, significance', ipa: '/bəˈdɔɪ̯tʊŋ/', ex: 'Das hat eine große Bedeutung.', exTr: 'That has great significance.', level: 'B1', type: 'noun', lang: 'de' },
  { word: 'verstehen', tr: 'to understand', ipa: '/fɛɐ̯ˈʃteːən/', ex: 'Ich verstehe dich gut.', exTr: 'I understand you well.', level: 'A2', type: 'verb', lang: 'de' },
  { word: 'die Stunde', tr: 'the hour', ipa: '/ˈʃtʊndə/', ex: 'Wir treffen uns in einer Stunde.', exTr: 'We meet in an hour.', level: 'A1', type: 'noun', lang: 'de' },
  { word: 'die Beziehung', tr: 'the relationship', ipa: '/bəˈt͡siːʊŋ/', ex: 'Ihre Beziehung ist eng.', exTr: 'Their relationship is close.', level: 'B1', type: 'noun', lang: 'de' },
  { word: 'der Unterschied', tr: 'the difference', ipa: '/ˈʊntɐʃiːt/', ex: 'Der Unterschied ist klein.', exTr: 'The difference is small.', level: 'B1', type: 'noun', lang: 'de' },
  { word: 'die Erfahrung', tr: 'the experience', ipa: '/ɛɐ̯ˈfaːʁʊŋ/', ex: 'Sie hat viel Erfahrung.', exTr: 'She has a lot of experience.', level: 'B1', type: 'noun', lang: 'de' },
];

const SENTENCES_B1: ImportCardPayload[] = [
  { word: 'Es lohnt sich.', tr: 'It is worth it.', ex: 'Der Aufstieg ist hart, aber es lohnt sich.', exTr: 'The climb is hard, but it is worth it.', level: 'B1', type: 'phrase', lang: 'de' },
  { word: 'Ich bin gespannt.', tr: 'I am curious / excited.', ex: 'Ich bin gespannt auf das Ergebnis.', exTr: 'I am curious about the result.', level: 'B1', type: 'phrase', lang: 'de' },
  { word: 'Das kommt nicht in Frage.', tr: 'That is out of the question.', ex: 'Aufgeben? Das kommt nicht in Frage.', exTr: 'Give up? Out of the question.', level: 'B2', type: 'phrase', lang: 'de' },
  { word: 'Es liegt mir auf der Zunge.', tr: "It's on the tip of my tongue.", ex: 'Sein Name liegt mir auf der Zunge.', exTr: 'His name is on the tip of my tongue.', level: 'B2', type: 'phrase', lang: 'de' },
  { word: 'Ich habe es eilig.', tr: 'I am in a hurry.', ex: 'Entschuldigung, ich habe es eilig.', exTr: 'Sorry, I am in a hurry.', level: 'B1', type: 'phrase', lang: 'de' },
  { word: 'Das macht nichts.', tr: 'It does not matter.', ex: 'Zu spät? Das macht nichts.', exTr: 'Too late? It does not matter.', level: 'A2', type: 'phrase', lang: 'de' },
  { word: 'Es hängt davon ab.', tr: 'It depends.', ex: 'Es hängt vom Wetter ab.', exTr: 'It depends on the weather.', level: 'B1', type: 'phrase', lang: 'de' },
  { word: 'Mir ist langweilig.', tr: 'I am bored.', ex: 'Im Winter ist mir oft langweilig.', exTr: 'In winter I am often bored.', level: 'A2', type: 'phrase', lang: 'de' },
];

export const SHARED_DECKS: SharedDeck[] = [
  {
    id: 'top4000',
    name: 'German Top 4000 Vocabulary',
    cards: TOP4000.length,
    cat: 'German',
    by: 'AnkiWeb',
    flag: '🇩🇪',
    lang: 'German',
    payload: TOP4000,
  },
  {
    id: 'goethe-a1',
    name: 'Goethe-Institut A1 Wortliste',
    cards: GOETHE_A1.length,
    cat: 'German',
    by: 'AnkiWeb',
    flag: '🇩🇪',
    lang: 'German',
    payload: GOETHE_A1,
  },
  {
    id: 'sentences-b1',
    name: 'German Sentences — B1/B2',
    cards: SENTENCES_B1.length,
    cat: 'German',
    by: 'AnkiWeb',
    flag: '🇩🇪',
    lang: 'German',
    payload: SENTENCES_B1,
  },
];

export function sharedDeckFromLink(link: string): SharedDeck {
  return {
    id: 'linked',
    name: `AnkiWeb deck ${link.replace(/^https?:\/\//, '').slice(0, 24)}`,
    cards: GOETHE_A1.length,
    cat: 'German',
    by: 'AnkiWeb',
    flag: '🇩🇪',
    lang: 'German',
    payload: GOETHE_A1,
  };
}
