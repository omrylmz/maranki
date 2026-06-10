/**
 * First-run seed content. The numbers stay HONEST: deck counts derive from
 * the cards that actually exist (no fake "5000"), SRS states are spread so
 * the dashboard, launchpad and library look lived-in on first boot, and the
 * activity history backs the heatmap/streak strip.
 *
 * Sample vocabulary expands the corpus in design/ui_kits/app-v2/data.jsx.
 */
import {
  AppSettings,
  Card,
  CefrLevel,
  Collection,
  DataState,
  DAY,
  dayKeyOf,
  DEFAULT_APP_SETTINGS,
  Deck,
  Lang,
  MIN,
  Person,
  Rating,
  SessionRecord,
  WordType,
} from './types';

/* Deterministic tiny PRNG so the seed is stable run-to-run. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

type Spec = [
  word: string,
  tr: string,
  ipa: string,
  ex: string,
  exTr: string,
  level: CefrLevel,
  type: WordType,
];

const ARTICLES = ['der', 'die', 'das', 'el', 'la', 'los', 'las', 'le', 'la', 'les'];

function splitArticle(word: string): { article: string | null; base: string } {
  const sp = word.indexOf(' ');
  if (sp > 0) {
    const head = word.slice(0, sp);
    if (ARTICLES.includes(head)) return { article: head, base: word.slice(sp + 1) };
  }
  return { article: null, base: word };
}

/* ------------------------------------------------------------- corpora */

const DE_EVERYDAY: Spec[] = [
  ['die Stunde', 'the hour', '/ˈʃtʊndə/', 'Wir treffen uns in einer Stunde.', 'We meet in an hour.', 'A1', 'noun'],
  ['verstehen', 'to understand', '/fɛɐ̯ˈʃteːən/', 'Ich verstehe dich gut.', 'I understand you well.', 'A2', 'verb'],
  ['die Erfahrung', 'the experience', '/ɛɐ̯ˈfaːʁʊŋ/', 'Sie hat viel Erfahrung.', 'She has a lot of experience.', 'B1', 'noun'],
  ['gemütlich', 'cosy, comfortable', '/ɡəˈmyːtlɪç/', 'Das Café ist sehr gemütlich.', 'The café is very cosy.', 'B2', 'adjective'],
  ['der Vorschlag', 'the suggestion', '/ˈfoːɐ̯ʃlaːk/', 'Das ist ein guter Vorschlag.', "That's a good suggestion.", 'B1', 'noun'],
  ['aufräumen', 'to tidy up', '/ˈaʊ̯fˌʁɔɪ̯mən/', 'Ich muss mein Zimmer aufräumen.', 'I have to tidy my room.', 'A2', 'verb'],
  ['die Gelegenheit', 'the opportunity', '/ɡəˈleːɡn̩haɪ̯t/', 'Das ist eine gute Gelegenheit.', 'That is a good opportunity.', 'B1', 'noun'],
  ['zuverlässig', 'reliable', '/ˈt͡suːfɛɐ̯ˌlɛsɪç/', 'Er ist ein zuverlässiger Kollege.', 'He is a reliable colleague.', 'B2', 'adjective'],
  ['das Frühstück', 'the breakfast', '/ˈfʁyːʃtʏk/', 'Das Frühstück ist fertig.', 'Breakfast is ready.', 'A1', 'noun'],
  ['die Wohnung', 'the apartment', '/ˈvoːnʊŋ/', 'Die Wohnung hat drei Zimmer.', 'The apartment has three rooms.', 'A1', 'noun'],
  ['arbeiten', 'to work', '/ˈaʁbaɪ̯tn̩/', 'Ich arbeite von zu Hause.', 'I work from home.', 'A1', 'verb'],
  ['kaufen', 'to buy', '/ˈkaʊ̯fn̩/', 'Wir kaufen frisches Brot.', 'We buy fresh bread.', 'A1', 'verb'],
  ['der Schlüssel', 'the key', '/ˈʃlʏsl̩/', 'Wo ist mein Schlüssel?', 'Where is my key?', 'A1', 'noun'],
  ['das Fenster', 'the window', '/ˈfɛnstɐ/', 'Mach bitte das Fenster zu.', 'Please close the window.', 'A1', 'noun'],
  ['heute', 'today', '/ˈhɔɪ̯tə/', 'Heute scheint die Sonne.', 'The sun is shining today.', 'A1', 'adverb'],
  ['morgen', 'tomorrow', '/ˈmɔʁɡn̩/', 'Bis morgen!', 'See you tomorrow!', 'A1', 'adverb'],
  ['immer', 'always', '/ˈɪmɐ/', 'Sie kommt immer pünktlich.', 'She always arrives on time.', 'A1', 'adverb'],
  ['der Bahnhof', 'the train station', '/ˈbaːnhoːf/', 'Der Zug verlässt den Bahnhof.', 'The train leaves the station.', 'A1', 'noun'],
  ['die Rechnung', 'the bill, invoice', '/ˈʁɛçnʊŋ/', 'Die Rechnung, bitte.', 'The bill, please.', 'A2', 'noun'],
  ['schmecken', 'to taste (good)', '/ˈʃmɛkn̩/', 'Die Suppe schmeckt sehr gut.', 'The soup tastes very good.', 'A2', 'verb'],
  ['die Ausbildung', 'the (vocational) training', '/ˈaʊ̯sbɪldʊŋ/', 'Er macht eine Ausbildung als Koch.', 'He is training as a cook.', 'B1', 'noun'],
  ['anstrengend', 'exhausting, strenuous', '/ˈanʃtʁɛŋənt/', 'Der Umzug war sehr anstrengend.', 'The move was very exhausting.', 'A2', 'adjective'],
  ['sich erinnern', 'to remember', '/ɛɐ̯ˈʔɪnɐn/', 'Ich erinnere mich an den Sommer.', 'I remember the summer.', 'A2', 'verb'],
  ['der Termin', 'the appointment', '/tɛʁˈmiːn/', 'Ich habe morgen einen Termin.', 'I have an appointment tomorrow.', 'A2', 'noun'],
  ['die Umgebung', 'the surroundings', '/ʊmˈɡeːbʊŋ/', 'Die Umgebung ist sehr ruhig.', 'The surroundings are very quiet.', 'B1', 'noun'],
  ['entscheiden', 'to decide', '/ɛntˈʃaɪ̯dn̩/', 'Du musst dich entscheiden.', 'You have to decide.', 'B1', 'verb'],
  ['die Verabredung', 'the (social) appointment, date', '/fɛɐ̯ˈʔapʁeːdʊŋ/', 'Wir haben eine Verabredung um acht.', 'We have a date at eight.', 'B1', 'noun'],
  ['gewöhnlich', 'usual, ordinary', '/ɡəˈvøːnlɪç/', 'Ich stehe gewöhnlich früh auf.', 'I usually get up early.', 'B1', 'adjective'],
  ['die Voraussetzung', 'the prerequisite', '/foˈʁaʊ̯szɛt͡sʊŋ/', 'Geduld ist eine wichtige Voraussetzung.', 'Patience is an important prerequisite.', 'B2', 'noun'],
  ['nachvollziehen', 'to comprehend, relate to', '/ˈnaːxfɔlˌt͡siːən/', 'Ich kann deine Entscheidung nachvollziehen.', 'I can relate to your decision.', 'B2', 'verb'],
  ['die Herausforderung', 'the challenge', '/hɛˈʁaʊ̯sfɔʁdəʁʊŋ/', 'Die neue Stelle ist eine Herausforderung.', 'The new job is a challenge.', 'B1', 'noun'],
  ['vereinbaren', 'to arrange, agree upon', '/fɛɐ̯ˈʔaɪ̯nbaːʁən/', 'Wir vereinbaren einen Termin.', 'We arrange an appointment.', 'B2', 'verb'],
  ['der Alltag', 'the everyday life', '/ˈalˌtaːk/', 'Sport gehört zu meinem Alltag.', 'Exercise is part of my everyday life.', 'A2', 'noun'],
  ['das Gespräch', 'the conversation', '/ɡəˈʃpʁɛːç/', 'Wir hatten ein langes Gespräch.', 'We had a long conversation.', 'A2', 'noun'],
  ['die Antwort', 'the answer', '/ˈantvɔʁt/', 'Ich warte auf deine Antwort.', 'I am waiting for your answer.', 'A1', 'noun'],
  ['fragen', 'to ask', '/ˈfʁaːɡn̩/', 'Darf ich etwas fragen?', 'May I ask something?', 'A1', 'verb'],
  ['die Woche', 'the week', '/ˈvɔxə/', 'Nächste Woche habe ich Urlaub.', 'Next week I am on holiday.', 'A1', 'noun'],
  ['das Wetter', 'the weather', '/ˈvɛtɐ/', 'Das Wetter wird besser.', 'The weather is improving.', 'A1', 'noun'],
  ['der Feierabend', 'the end of the workday', '/ˈfaɪ̯ɐʔaːbn̩t/', 'Nach Feierabend gehen wir spazieren.', 'After work we go for a walk.', 'B1', 'noun'],
  ['unterwegs', 'on the way, out and about', '/ʊntɐˈveːks/', 'Ich bin gerade unterwegs.', 'I am on my way right now.', 'A2', 'adverb'],
  ['die Möglichkeit', 'the possibility', '/ˈmøːklɪçkaɪ̯t/', 'Es gibt mehrere Möglichkeiten.', 'There are several possibilities.', 'B1', 'noun'],
  ['leihen', 'to lend, borrow', '/ˈlaɪ̯ən/', 'Kannst du mir das Buch leihen?', 'Can you lend me the book?', 'A2', 'verb'],
  ['die Erinnerung', 'the memory', '/ɛɐ̯ˈʔɪnəʁʊŋ/', 'Das Foto weckt schöne Erinnerungen.', 'The photo brings back fond memories.', 'B1', 'noun'],
  ['der Geburtstag', 'the birthday', '/ɡəˈbuːɐ̯tstaːk/', 'Herzlichen Glückwunsch zum Geburtstag!', 'Happy birthday!', 'A1', 'noun'],
];

const DE_CONVERSATION: Spec[] = [
  ['die Meinung', 'the opinion', '/ˈmaɪ̯nʊŋ/', 'Meiner Meinung nach stimmt das.', 'In my opinion, that is true.', 'B1', 'noun'],
  ['überzeugen', 'to convince', '/yːbɐˈt͡sɔɪ̯ɡn̩/', 'Du hast mich überzeugt.', 'You have convinced me.', 'B1', 'verb'],
  ['der Eindruck', 'the impression', '/ˈaɪ̯ndʁʊk/', 'Sie macht einen guten Eindruck.', 'She makes a good impression.', 'B1', 'noun'],
  ['das Missverständnis', 'the misunderstanding', '/ˈmɪsfɛɐ̯ˌʃtɛntnɪs/', 'Das war nur ein Missverständnis.', 'That was just a misunderstanding.', 'B1', 'noun'],
  ['ehrlich gesagt', 'to be honest', '/ˈeːɐ̯lɪç ɡəˈzaːkt/', 'Ehrlich gesagt, bin ich müde.', 'To be honest, I am tired.', 'B1', 'phrase'],
  ['zustimmen', 'to agree', '/ˈt͡suːʃtɪmən/', 'Ich stimme dir völlig zu.', 'I completely agree with you.', 'B1', 'verb'],
  ['der Zusammenhang', 'the connection, context', '/t͡suˈzamənhaŋ/', 'Ich sehe keinen Zusammenhang.', 'I see no connection.', 'B2', 'noun'],
  ['ausdrücken', 'to express', '/ˈaʊ̯sdʁʏkn̩/', 'Wie soll ich das ausdrücken?', 'How should I express that?', 'B1', 'verb'],
  ['die Ansicht', 'the view, opinion', '/ˈanzɪçt/', 'Wir teilen dieselbe Ansicht.', 'We share the same view.', 'B2', 'noun'],
  ['vorschlagen', 'to suggest', '/ˈfoːɐ̯ʃlaːɡn̩/', 'Ich schlage eine Pause vor.', 'I suggest a break.', 'B1', 'verb'],
  ['allerdings', 'however, though', '/ˈalɐdɪŋs/', 'Allerdings habe ich wenig Zeit.', 'However, I have little time.', 'B1', 'adverb'],
  ['das Vorurteil', 'the prejudice', '/ˈfoːɐ̯ʔʊʁtaɪ̯l/', 'Er ist frei von Vorurteilen.', 'He is free of prejudice.', 'B2', 'noun'],
  ['die Auseinandersetzung', 'the dispute, argument', '/aʊ̯sʔaɪ̯ˈnandɐzɛt͡sʊŋ/', 'Die Auseinandersetzung war heftig.', 'The argument was fierce.', 'C1', 'noun'],
  ['beziehungsweise', 'or rather, respectively', '/bəˈt͡siːʊŋsvaɪ̯zə/', 'Montag beziehungsweise Dienstag passt.', 'Monday, or rather Tuesday, works.', 'B2', 'adverb'],
  ['der Standpunkt', 'the standpoint', '/ˈʃtantpʊŋkt/', 'Von meinem Standpunkt aus ist das fair.', 'From my standpoint, that is fair.', 'B2', 'noun'],
  ['begründen', 'to justify, give reasons', '/bəˈɡʁʏndn̩/', 'Kannst du deine Meinung begründen?', 'Can you justify your opinion?', 'B2', 'verb'],
  ['das Anliegen', 'the concern, request', '/ˈanliːɡn̩/', 'Ich habe ein kleines Anliegen.', 'I have a small request.', 'C1', 'noun'],
  ['unterbrechen', 'to interrupt', '/ʊntɐˈbʁɛçn̩/', 'Entschuldige, dass ich unterbreche.', 'Sorry for interrupting.', 'B1', 'verb'],
  ['die Rückmeldung', 'the feedback', '/ˈʁʏkmɛldʊŋ/', 'Danke für die schnelle Rückmeldung.', 'Thanks for the quick feedback.', 'B2', 'noun'],
  ['nachfragen', 'to inquire, follow up', '/ˈnaːxfʁaːɡn̩/', 'Ich frage beim Amt nach.', 'I will follow up with the office.', 'B1', 'verb'],
  ['im Großen und Ganzen', 'on the whole', '/ɪm ˈɡʁoːsn̩ ʊnt ˈɡant͡sn̩/', 'Im Großen und Ganzen war es gut.', 'On the whole, it was good.', 'B2', 'phrase'],
  ['die Einstellung', 'the attitude', '/ˈaɪ̯nʃtɛlʊŋ/', 'Ihre Einstellung ist vorbildlich.', 'Her attitude is exemplary.', 'B2', 'noun'],
  ['es kommt darauf an', 'it depends', '/ɛs kɔmt daˈʁaʊ̯f ʔan/', 'Es kommt darauf an, wann du kannst.', 'It depends on when you can.', 'B1', 'phrase'],
  ['verhandeln', 'to negotiate', '/fɛɐ̯ˈhandl̩n/', 'Wir verhandeln über den Preis.', 'We are negotiating the price.', 'B2', 'verb'],
];

const ES_SENTENCES: Spec[] = [
  ['mañana', 'tomorrow; morning', '/maˈɲana/', 'Hasta mañana, nos vemos.', 'See you tomorrow.', 'A1', 'adverb'],
  ['el aprendizaje', 'the learning', '/apɾendiˈθaxe/', 'El aprendizaje nunca termina.', 'Learning never ends.', 'B1', 'noun'],
  ['aprovechar', 'to make the most of', '/apɾoβeˈt͡ʃaɾ/', 'Hay que aprovechar el tiempo.', 'One must make the most of time.', 'B2', 'verb'],
  ['sin embargo', 'however', '/sin emˈbaɾɣo/', 'Sin embargo, decidió quedarse.', 'However, she decided to stay.', 'B1', 'phrase'],
  ['la costumbre', 'the habit, custom', '/kosˈtumbɾe/', 'Es una costumbre muy antigua.', 'It is a very old custom.', 'B1', 'noun'],
  ['desarrollar', 'to develop', '/desaroˈʝaɾ/', 'Quiero desarrollar nuevas habilidades.', 'I want to develop new skills.', 'B1', 'verb'],
  ['la madrugada', 'the early morning', '/maðɾuˈɣaða/', 'Llegamos de madrugada.', 'We arrived in the early morning.', 'B2', 'noun'],
  ['cotidiano', 'everyday, daily', '/kotiˈðjano/', 'Forma parte de la vida cotidiana.', 'It is part of everyday life.', 'B2', 'adjective'],
  ['el esfuerzo', 'the effort', '/esˈfweɾθo/', 'El esfuerzo vale la pena.', 'The effort is worth it.', 'A2', 'noun'],
  ['lograr', 'to achieve', '/loˈɣɾaɾ/', 'Lograste tu objetivo.', 'You achieved your goal.', 'B1', 'verb'],
  ['la herramienta', 'the tool', '/eraˈmjenta/', 'El idioma es una herramienta poderosa.', 'Language is a powerful tool.', 'B1', 'noun'],
  ['disfrutar', 'to enjoy', '/disfɾuˈtaɾ/', 'Disfruta el momento.', 'Enjoy the moment.', 'A2', 'verb'],
  ['quizás', 'perhaps', '/kiˈθas/', 'Quizás llueva esta tarde.', 'Perhaps it will rain this afternoon.', 'A2', 'adverb'],
  ['el recuerdo', 'the memory, souvenir', '/reˈkweɾðo/', 'Guardo un buen recuerdo de ese viaje.', 'I have fond memories of that trip.', 'B1', 'noun'],
  ['mejorar', 'to improve', '/mexoˈɾaɾ/', 'Tu español mejora cada día.', 'Your Spanish improves every day.', 'A2', 'verb'],
  ['la meta', 'the goal', '/ˈmeta/', 'Mi meta es hablar con fluidez.', 'My goal is to speak fluently.', 'B1', 'noun'],
];

const ES_TRAVEL: Spec[] = [
  ['el billete', 'the ticket', '/biˈʝete/', 'Necesito un billete de ida y vuelta.', 'I need a return ticket.', 'A2', 'noun'],
  ['la estación', 'the station', '/estaˈθjon/', '¿Dónde está la estación de tren?', 'Where is the train station?', 'A1', 'noun'],
  ['alquilar', 'to rent', '/alkiˈlaɾ/', 'Queremos alquilar un coche.', 'We want to rent a car.', 'A2', 'verb'],
  ['la habitación', 'the room', '/aβitaˈθjon/', 'La habitación tiene vistas al mar.', 'The room has a sea view.', 'A1', 'noun'],
  ['el equipaje', 'the luggage', '/ekiˈpaxe/', 'Mi equipaje no ha llegado.', 'My luggage has not arrived.', 'A2', 'noun'],
  ['perderse', 'to get lost', '/peɾˈðeɾse/', 'Nos perdimos en el casco antiguo.', 'We got lost in the old town.', 'B1', 'verb'],
  ['la propina', 'the tip', '/pɾoˈpina/', '¿Dejamos propina aquí?', 'Do we leave a tip here?', 'B1', 'noun'],
  ['el vuelo', 'the flight', '/ˈbwelo/', 'El vuelo sale a las nueve.', 'The flight leaves at nine.', 'A1', 'noun'],
];

const FR_BASICS: Spec[] = [
  ['le matin', 'the morning', '/lə matɛ̃/', 'Je me lève tôt le matin.', 'I get up early in the morning.', 'A1', 'noun'],
  ['la semaine', 'the week', '/la səmɛn/', 'La semaine passe vite.', 'The week goes by quickly.', 'A1', 'noun'],
  ['manger', 'to eat', '/mɑ̃ʒe/', 'Nous mangeons ensemble ce soir.', 'We eat together tonight.', 'A1', 'verb'],
  ['le livre', 'the book', '/lə livʁ/', 'Ce livre est passionnant.', 'This book is fascinating.', 'A1', 'noun'],
  ['demain', 'tomorrow', '/dəmɛ̃/', 'À demain !', 'See you tomorrow!', 'A1', 'adverb'],
  ['la gare', 'the train station', '/la ɡaʁ/', 'La gare est tout près.', 'The station is very close.', 'A1', 'noun'],
];

/* ------------------------------------------------------------ assembly */

interface DeckSeed {
  deck: Omit<Deck, 'createdAt'>;
  specs: Spec[];
  lang: Lang;
  /** [mastered, review, learning, new] proportions by index order. */
  mix: [number, number, number, number];
  /** How many of the review cards should already be due. */
  dueReviews: number;
  dueLearning: number;
}

const DECK_SEEDS: DeckSeed[] = [
  {
    deck: { id: 'de-everyday', name: 'German — Everyday', flag: '🇩🇪', lang: 'German', level: 'A1', builtin: true, active: true },
    specs: DE_EVERYDAY,
    lang: 'de',
    mix: [18, 12, 4, 10],
    dueReviews: 8,
    dueLearning: 3,
  },
  {
    deck: { id: 'de-conversation', name: 'German — Conversation', flag: '🇩🇪', lang: 'German', level: 'B1', builtin: true, active: true },
    specs: DE_CONVERSATION,
    lang: 'de',
    mix: [6, 8, 2, 8],
    dueReviews: 4,
    dueLearning: 1,
  },
  {
    deck: { id: 'es-sentences', name: 'Spanish — Core Sentences', flag: '🇪🇸', lang: 'Spanish', level: null, builtin: false, active: true },
    specs: ES_SENTENCES,
    lang: 'es',
    mix: [4, 5, 1, 6],
    dueReviews: 2,
    dueLearning: 1,
  },
  {
    deck: { id: 'es-travel', name: 'Spanish — Travel', flag: '🇪🇸', lang: 'Spanish', level: 'B1', builtin: true, active: false },
    specs: ES_TRAVEL,
    lang: 'es',
    mix: [4, 2, 0, 2],
    dueReviews: 0,
    dueLearning: 0,
  },
  {
    deck: { id: 'fr-basics', name: 'French — Basics', flag: '🇫🇷', lang: 'French', level: 'A1', builtin: true, active: false },
    specs: FR_BASICS,
    lang: 'fr',
    mix: [0, 0, 0, 6],
    dueReviews: 0,
    dueLearning: 0,
  },
];

function buildCards(now: number): Card[] {
  const rnd = lcg(0x5eed);
  const cards: Card[] = [];

  DECK_SEEDS.forEach((seed, deckIdx) => {
    const [nMastered, nReview, nLearning] = seed.mix;
    let dueReviewsLeft = seed.dueReviews;
    let dueLearningLeft = seed.dueLearning;

    seed.specs.forEach((spec, i) => {
      const [word, tr, ipa, ex, exTr, level, type] = spec;
      const { article, base } = splitArticle(word);
      const createdAt = now - (200 - i * 2 - deckIdx * 10) * DAY;
      const id = `${seed.deck.id}-${i + 1}`;

      const common = {
        id,
        deckId: seed.deck.id,
        word,
        article,
        base,
        tr,
        ipa,
        ex,
        exTr,
        level,
        type,
        lang: seed.lang,
        fav: rnd() < 0.12,
        flagged: false,
        suspended: false,
        buriedUntil: null,
        createdAt,
      };

      let card: Card;
      if (i < nMastered) {
        // mastered: interval ≥ 21d, mostly scheduled in the future
        const interval = 21 + Math.floor(rnd() * 100);
        const overdue = dueReviewsLeft > 0 && rnd() < 0.35;
        if (overdue) dueReviewsLeft -= 1;
        card = {
          ...common,
          ease: 2.5 + Math.round(rnd() * 4) * 0.05,
          intervalDays: interval,
          stepIndex: null,
          reps: 8 + Math.floor(rnd() * 12),
          lapses: Math.floor(rnd() * 2),
          due: overdue ? now - Math.floor(rnd() * 2) * DAY : now + Math.floor(rnd() * interval * 0.8 + 1) * DAY,
          lastReviewedAt: now - interval * DAY,
        };
      } else if (i < nMastered + nReview) {
        // young review cards: 2–14d intervals
        const interval = 2 + Math.floor(rnd() * 12);
        const overdue = dueReviewsLeft > 0;
        if (overdue) dueReviewsLeft -= 1;
        card = {
          ...common,
          ease: 2.1 + Math.round(rnd() * 6) * 0.05,
          intervalDays: interval,
          stepIndex: null,
          reps: 3 + Math.floor(rnd() * 5),
          lapses: rnd() < 0.4 ? 1 : 0,
          due: overdue ? now - Math.floor(rnd() * 18) * 3_600_000 : now + Math.floor(rnd() * interval * 0.7 + 1) * DAY,
          lastReviewedAt: now - interval * DAY,
        };
      } else if (i < nMastered + nReview + nLearning) {
        // in learning steps
        const step = rnd() < 0.5 ? 0 : 1;
        const dueNow = dueLearningLeft > 0;
        if (dueNow) dueLearningLeft -= 1;
        card = {
          ...common,
          ease: 2.5,
          intervalDays: 0,
          stepIndex: step,
          reps: 1 + step,
          lapses: 0,
          due: dueNow ? now - 5 * MIN : now + (10 + Math.floor(rnd() * 50)) * MIN,
          lastReviewedAt: now - 30 * MIN,
        };
      } else {
        // brand new
        card = {
          ...common,
          ease: 2.5,
          intervalDays: 0,
          stepIndex: null,
          reps: 0,
          lapses: 0,
          due: now,
          lastReviewedAt: null,
        };
      }
      cards.push(card);
    });
  });

  return cards;
}

/* History: ~5 weeks of sessions feeding the heatmap, streak strip and
   all-time ledger. The current streak is 12 days with one freeze used. */
function buildHistory(now: number): { sessions: SessionRecord[]; freezeUsedDays: string[] } {
  const rnd = lcg(0xacc1);
  const sessions: SessionRecord[] = [];
  const freezeUsedDays: string[] = [];
  const today = dayKeyOf(now);

  for (let back = 34; back >= 0; back--) {
    const dayMs = now - back * DAY;
    const dayKey = dayKeyOf(dayMs);
    // one frozen day inside the current streak, one true miss before it
    if (back === 6) {
      freezeUsedDays.push(dayKey);
      continue;
    }
    if (back === 12 || back === 19 || back === 26) continue; // missed days
    const n = back === 0 ? 1 : 1 + (rnd() < 0.25 ? 1 : 0);
    for (let s = 0; s < n; s++) {
      const total = 8 + Math.floor(rnd() * 18);
      const again = Math.floor(total * (0.05 + rnd() * 0.15));
      const easy = Math.floor(total * (0.1 + rnd() * 0.15));
      const hard = Math.floor(total * (0.08 + rnd() * 0.12));
      const good = total - again - easy - hard;
      const counts: Record<Rating, number> = { again, hard, good, easy };
      const xp = total * 2 + (total - again) * 2 + 10;
      sessions.push({
        id: `seed-s-${back}-${s}`,
        dayKey,
        atMs: dayMs - (2 - s) * 3 * 3_600_000,
        kind: 'scheduled',
        counts,
        total,
        bestRun: 3 + Math.floor(rnd() * 7),
        xp,
      });
    }
  }
  // make "today" reflect the seeded dayDone (14 reviews so far)
  const todaySession = sessions[sessions.length - 1];
  if (todaySession && todaySession.dayKey === today) {
    todaySession.total = 14;
    todaySession.counts = { again: 1, hard: 2, good: 8, easy: 3 };
    todaySession.xp = 14 * 2 + 13 * 2 + 10;
  }
  return { sessions, freezeUsedDays };
}

export function buildSeedState(now: number): DataState {
  const { sessions, freezeUsedDays } = buildHistory(now);
  const today = dayKeyOf(now);

  const person: Person = {
    xp: 2780, // level 7 "Wordsmith", 160 XP to level 8
    streak: 12,
    bestStreak: 23,
    freezes: 2,
    freezeUsedDays,
    lastStudyDay: today,
    goalReviews: 30,
    goalNew: 10,
    dayDone: { dayKey: today, reviews: 14, neww: 3 },
    fastAnswers: 63,
    achievements: {
      'first-steps': now - 39 * DAY,
      'week-warrior': now - 23 * DAY,
      centurion: now - 17 * DAY,
      'quick-draw': now - 11 * DAY,
    },
  };

  const collections: Collection[] = [
    { id: 'hard', name: 'Hardest cards', icon: 'flame', desc: 'Lowest ease across decks', query: 'hardest' },
    { id: 'fav', name: 'Favorites', icon: 'heart', desc: 'Cards you starred', query: 'favorites' },
    { id: 'daily', name: 'Daily practice', icon: 'today', desc: 'Young cards · interval 0–7d', query: 'young' },
  ];

  const settings: AppSettings = JSON.parse(JSON.stringify(DEFAULT_APP_SETTINGS));

  return {
    cards: buildCards(now),
    decks: DECK_SEEDS.map((s, i) => ({ ...s.deck, createdAt: now - (120 - i * 10) * DAY })),
    collections,
    person,
    sessions,
    reviewLog: [],
    settings,
    onboarded: false,
  };
}
