/* Maranki App Redesign v2 — sample content.
   Richer than v1: full card objects with SRS fields the screens surface
   (interval, predicted intervals per rating, state), decks incl. inactive +
   imported, collections with honest counts, achievements, heatmap data. */

const QUEUE = [
  { id: 'c1', word: 'die Stunde', article: 'die', base: 'Stunde', tr: 'the hour', ipa: '/ˈʃtʊndə/', ex: 'Wir treffen uns in einer Stunde.', exTr: 'We meet in an hour.', level: 'A1', type: 'noun', state: 'due', lang: 'de', step: null, pred: { again: 'soon', hard: '4d', good: '9d', easy: '21d' } },
  { id: 'c2', word: 'verstehen', article: null, base: 'verstehen', tr: 'to understand', ipa: '/fɛɐ̯ˈʃteːən/', ex: 'Ich verstehe dich gut.', exTr: 'I understand you well.', level: 'A2', type: 'verb', state: 'due', lang: 'de', step: null, pred: { again: 'soon', hard: '2d', good: '6d', easy: '14d' } },
  { id: 'c3', word: 'die Erfahrung', article: 'die', base: 'Erfahrung', tr: 'the experience', ipa: '/ɛɐ̯ˈfaːʁʊŋ/', ex: 'Sie hat viel Erfahrung.', exTr: 'She has a lot of experience.', level: 'B1', type: 'noun', state: 'learning', lang: 'de', step: '2/2 · 10m → 1d', pred: { again: 'soon', hard: '10m', good: '1d', easy: '4d' } },
  { id: 'c4', word: 'gemütlich', article: null, base: 'gemütlich', tr: 'cosy, comfortable', ipa: '/ɡəˈmyːtlɪç/', ex: 'Das Café ist sehr gemütlich.', exTr: 'The café is very cosy.', level: 'B2', type: 'adjective', state: 'new', lang: 'de', step: '1/2 · 1m → 10m', pred: { again: 'soon', hard: '1m', good: '10m', easy: '4d' } },
  { id: 'c5', word: 'der Vorschlag', article: 'der', base: 'Vorschlag', tr: 'the suggestion', ipa: '/ˈfoːɐ̯ʃlaːk/', ex: 'Das ist ein guter Vorschlag.', exTr: "That's a good suggestion.", level: 'B1', type: 'noun', state: 'due', lang: 'de', step: null, pred: { again: 'soon', hard: '5d', good: '12d', easy: '1mo' } },
  { id: 'c6', word: 'aufräumen', article: null, base: 'aufräumen', tr: 'to tidy up', ipa: '/ˈaʊ̯fˌʁɔɪ̯mən/', ex: 'Ich muss mein Zimmer aufräumen.', exTr: 'I have to tidy my room.', level: 'A2', type: 'verb', state: 'due', lang: 'de', step: null, pred: { again: 'soon', hard: '3d', good: '8d', easy: '19d' } },
];

const LIB = [
  ...QUEUE,
  { id: 'c7', word: 'mañana', article: null, base: 'mañana', tr: 'tomorrow; morning', ipa: '/maˈɲana/', ex: 'Hasta mañana, nos vemos.', exTr: 'See you tomorrow.', level: 'A1', type: 'adverb', state: 'mastered', lang: 'es', interval: '2mo', fav: true },
  { id: 'c8', word: 'el aprendizaje', article: 'el', base: 'aprendizaje', tr: 'the learning', ipa: '/apɾendiˈθaxe/', ex: 'El aprendizaje nunca termina.', exTr: 'Learning never ends.', level: 'B1', type: 'noun', state: 'review', lang: 'es', interval: '6d' },
  { id: 'c9', word: 'aprovechar', article: null, base: 'aprovechar', tr: 'to make the most of', ipa: '/apɾoβeˈt͡ʃaɾ/', ex: 'Hay que aprovechar el tiempo.', exTr: 'One must make the most of time.', level: 'B2', type: 'verb', state: 'new', lang: 'es' },
  { id: 'c10', word: 'die Gelegenheit', article: 'die', base: 'Gelegenheit', tr: 'the opportunity', ipa: '/ɡəˈleːɡn̩haɪ̯t/', ex: 'Das ist eine gute Gelegenheit.', exTr: 'That is a good opportunity.', level: 'B1', type: 'noun', state: 'mastered', lang: 'de', interval: '3mo', fav: true },
  { id: 'c11', word: 'sin embargo', article: null, base: 'sin embargo', tr: 'however', ipa: '/sin emˈbaɾɣo/', ex: 'Sin embargo, decidió quedarse.', exTr: 'However, she decided to stay.', level: 'B1', type: 'phrase', state: 'review', lang: 'es', interval: '12d' },
  { id: 'c12', word: 'zuverlässig', article: null, base: 'zuverlässig', tr: 'reliable', ipa: '/ˈt͡suːfɛɐ̯ˌlɛsɪç/', ex: 'Er ist ein zuverlässiger Kollege.', exTr: 'He is a reliable colleague.', level: 'B2', type: 'adjective', state: 'learning', lang: 'de' },
];

const DECKS = [
  { id: 'de-a1', name: 'German — Everyday', flag: '🇩🇪', lang: 'German', total: 240, mastered: 163, learning: 22, neww: 55, due: 14, level: 'A1', builtin: true, active: true },
  { id: 'de-b1', name: 'German — Conversation', flag: '🇩🇪', lang: 'German', total: 320, mastered: 96, learning: 40, neww: 184, due: 9, level: 'B1', builtin: true, active: true },
  { id: 'es-5000', name: '5000 Spanish Sentences', flag: '🇪🇸', lang: 'Spanish', total: 5000, mastered: 210, learning: 60, neww: 4730, due: 3, level: null, builtin: false, active: true },
  { id: 'es-travel', name: 'Spanish — Travel', flag: '🇪🇸', lang: 'Spanish', total: 180, mastered: 74, learning: 18, neww: 88, due: 0, level: 'B1', builtin: true, active: false },
  { id: 'fr-a1', name: 'French — Basics', flag: '🇫🇷', lang: 'French', total: 150, mastered: 0, learning: 0, neww: 150, due: 0, level: 'A1', builtin: true, active: false },
];

const COLLECTIONS = [
  { id: 'hard', name: 'Hardest cards', icon: 'flame', count: 42, due: 11, desc: 'Lowest ease across decks', sort: 'hardest' },
  { id: 'fav', name: 'Favorites', icon: 'heart', count: 28, due: 4, desc: 'Cards you starred', sort: 'smart' },
  { id: 'daily', name: 'Daily practice', icon: 'today', count: 60, due: 11, desc: 'Young cards · interval 0–7d', sort: 'smart' },
];

const ACHIEVEMENTS = [
  { id: 1, name: 'First steps', desc: 'Complete your first session', icon: 'footsteps', cat: 'Study', unlocked: true, date: 'May 2' },
  { id: 2, name: 'Week warrior', desc: 'Hold a 7-day streak', icon: 'flame', cat: 'Streak', unlocked: true, date: 'May 18' },
  { id: 3, name: 'Centurion', desc: 'Master 100 cards', icon: 'ribbon', cat: 'Mastery', unlocked: true, date: 'May 24' },
  { id: 4, name: 'Quick draw', desc: '50 fast answers', icon: 'flash', cat: 'Speed', unlocked: true, date: 'May 30' },
  { id: 5, name: 'Fortnight', desc: 'Hold a 14-day streak', icon: 'calendar', cat: 'Streak', unlocked: false, prog: 12, goal: 14 },
  { id: 6, name: 'Scholar', desc: 'Master 500 cards', icon: 'school', cat: 'Mastery', unlocked: false, prog: 343, goal: 500 },
  { id: 7, name: 'Marathon', desc: 'Hold a 30-day streak', icon: 'trophy', cat: 'Streak', unlocked: false, prog: 12, goal: 30 },
  { id: 8, name: 'Polyglot', desc: 'Study three languages', icon: 'globe', cat: 'Study', unlocked: false, prog: 2, goal: 3 },
];

/* last 14 days for the streak strip: s=studied, f=frozen, m=missed, t=today */
const DAYS14 = ['s','s','s','m','s','s','f','s','s','s','s','s','s','t'];

/* 5-week heatmap, intensity 0–4, latest week last */
const HEAT = [
  [1,2,0,3,1,2,2],
  [2,3,1,0,2,4,1],
  [0,2,3,2,1,2,3],
  [2,1,2,4,3,0,2],
  [3,2,1,2,4,3,1],
];

const PERSON = {
  streak: 12, best: 23, freezes: 2, level: 7, levelName: 'Wordsmith',
  xp: 2840, xpNext: 160, masteryPct: 68, masteredCards: 843, totalCards: 1240,
  retention: 84, studiedToday: 17, goalReviews: 30, doneReviews: 14, goalNew: 10, doneNew: 3,
};

const READY = { total: 26, due: 18, neww: 5, learning: 3, mins: 10 };

Object.assign(window, { QUEUE, LIB, DECKS, COLLECTIONS, ACHIEVEMENTS, DAYS14, HEAT, PERSON, READY });
