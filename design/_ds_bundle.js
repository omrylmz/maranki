/* @ds-bundle: {"format":3,"namespace":"MarankiDesignSystem_9118c1","components":[],"sourceHashes":{"ion-inline.js":"ab62e3b648ce","ui_kits/app-v2/app.jsx":"a36353025ba1","ui_kits/app-v2/data.jsx":"56fb9c31f8c6","ui_kits/app-v2/ios-frame.jsx":"39f3a091d97d","ui_kits/app-v2/screen-browse.jsx":"654ddd5c3df5","ui_kits/app-v2/screen-complete.jsx":"168a11fe19b5","ui_kits/app-v2/screen-editors.jsx":"c44efb4a322a","ui_kits/app-v2/screen-home.jsx":"446f6bf3c965","ui_kits/app-v2/screen-import.jsx":"61fcce2e46c6","ui_kits/app-v2/screen-launchpad.jsx":"5874f92183c0","ui_kits/app-v2/screen-onboarding.jsx":"9ab418910260","ui_kits/app-v2/screen-session.jsx":"ffd02c27528d","ui_kits/app-v2/screen-settings.jsx":"1f666ac52ae5","ui_kits/app-v2/screen-stats.jsx":"cf2e1360194b","ui_kits/app-v2/tweaks-panel.jsx":"6591467622ed","ui_kits/app-v2/ui.jsx":"6848907eddda"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.MarankiDesignSystem_9118c1 = window.MarankiDesignSystem_9118c1 || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// ion-inline.js
try { (() => {
/* ion-inline.js — reliable Ionicons rendering.
   Ionicons' own web component lazy-fetches each SVG at render time, which is
   blocked in some sandboxed iframes. This helper instead fetches the same
   official Ionicons SVGs once and inlines them into every <ion-icon name="…">,
   so the exact Ionicons vocabulary renders everywhere (React kit + static cards).
   Color is inherited via currentColor; size via the element's font-size. */
(function () {
  var BASE = 'https://cdn.jsdelivr.net/npm/ionicons@7.4.0/dist/ionicons/svg/';
  var cache = {};

  // inject sizing + color rules once
  var style = document.createElement('style');
  style.textContent = 'ion-icon{display:inline-flex;align-items:center;justify-content:center;vertical-align:middle;}' + 'ion-icon svg{width:1em;height:1em;display:block;fill:currentColor;stroke:none;}' + 'ion-icon .ionicon-fill-none{fill:none;stroke:currentColor;}' + 'ion-icon .ionicon-stroke-width{stroke-width:32px;}';
  (document.head || document.documentElement).appendChild(style);
  function load(name) {
    if (cache[name]) return cache[name];
    cache[name] = fetch(BASE + name + '.svg').then(function (r) {
      return r.ok ? r.text() : '';
    }).catch(function () {
      return '';
    });
    return cache[name];
  }
  function render(el) {
    var name = el.getAttribute('name');
    if (!name) return;
    el.setAttribute('data-ion-rendered', name);
    load(name).then(function (svg) {
      if (svg && el.getAttribute('name') === name) el.innerHTML = svg;
    });
  }
  function scan() {
    var els = document.querySelectorAll('ion-icon');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.getAttribute('data-ion-rendered') !== el.getAttribute('name')) render(el);
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scan);
  } else {
    scan();
  }
  // catch React / dynamically-added icons
  new MutationObserver(function () {
    scan();
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['name']
  });
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "ion-inline.js", error: String((e && e.message) || e) }); }

// ui_kits/app-v2/app.jsx
try { (() => {
/* Maranki App Redesign v2 — orchestrator.
   Owns: tab state, overlays (session / complete / editors / import /
   onboarding), the universal peek + create sheets, the global snackbar,
   theming (paper ⇆ evening via data-theme), and the Tweaks panel. */

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "light",
  "heroStyle": "stack",
  "paperGrain": true
} /*EDITMODE-END*/;
function MarankiApp({
  t,
  setTweak
}) {
  const {
    useState,
    useEffect
  } = React;
  const [tab, setTab] = useState('home');
  const [overlay, setOverlay] = useState(null); // {kind: 'session'|'complete'|'cardEditor'|'deckEditor'|'import'|'onboarding', ...}
  const [peek, setPeek] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [streakOpen, setStreakOpen] = useState(false);
  const [snack, setSnack] = useState(null);
  const [themeOverride, setThemeOverride] = useState(null); // moon toggle on Home

  const theme = themeOverride || (t.theme === 'system' ? 'light' : t.theme);
  useEffect(() => {
    if (!snack) return;
    const tm = setTimeout(() => setSnack(null), 2800);
    return () => clearTimeout(tm);
  }, [snack]);
  const startSession = () => setOverlay({
    kind: 'session'
  });
  const showSnack = text => setSnack(text);
  const closePeekAnd = fn => {
    const o = peek;
    setPeek(null);
    fn(o);
  };
  return /*#__PURE__*/React.createElement("div", {
    "data-theme": theme === 'dark' ? 'dark' : undefined,
    style: {
      position: 'relative',
      width: '100%',
      height: '100%',
      background: 'var(--paper)',
      overflow: 'hidden'
    }
  }, t.paperGrain && /*#__PURE__*/React.createElement("div", {
    className: "paper-grain-overlay",
    style: {
      position: 'absolute',
      inset: 0,
      pointerEvents: 'none',
      zIndex: 1,
      opacity: 'var(--grain-opacity)',
      backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)' opacity='1'/%3E%3C/svg%3E")`
    }
  }), tab === 'home' && /*#__PURE__*/React.createElement(HomeScreen, {
    heroStyle: t.heroStyle,
    theme: theme,
    onToggleTheme: () => setThemeOverride(theme === 'dark' ? 'light' : 'dark'),
    onStartSession: startSession,
    onPeekDeck: setPeek,
    onStudyDeck: startSession,
    onManage: () => setTab('study'),
    onOpenStreak: () => setStreakOpen(true)
  }), tab === 'study' && /*#__PURE__*/React.createElement(LaunchpadScreen, {
    onStartSession: startSession,
    onPeek: setPeek,
    onStudy: startSession,
    onCreate: () => setCreateOpen(true),
    onImport: () => setOverlay({
      kind: 'import'
    }),
    onSnack: showSnack
  }), tab === 'browse' && /*#__PURE__*/React.createElement(BrowseScreen, {
    onEditCard: card => setOverlay({
      kind: 'cardEditor',
      card
    }),
    onCreate: () => setCreateOpen(true),
    onSnack: showSnack
  }), tab === 'stats' && /*#__PURE__*/React.createElement(StatsScreen, {
    onStartSession: startSession,
    onSnack: showSnack
  }), tab === 'settings' && /*#__PURE__*/React.createElement(SettingsScreen, {
    theme: t.theme === 'system' && !themeOverride ? 'system' : theme,
    onTheme: v => {
      setThemeOverride(null);
      setTweak('theme', v);
    },
    onImport: () => setOverlay({
      kind: 'import'
    }),
    onReplayTour: () => setOverlay({
      kind: 'onboarding'
    }),
    onSnack: showSnack
  }), /*#__PURE__*/React.createElement(TabBar, {
    active: tab,
    onChange: setTab,
    studyDue: READY.total
  }), overlay?.kind === 'session' && /*#__PURE__*/React.createElement(SessionScreen, {
    onComplete: result => setOverlay({
      kind: 'complete',
      result
    }),
    onExit: () => setOverlay(null)
  }), overlay?.kind === 'complete' && /*#__PURE__*/React.createElement(CompleteScreen, {
    result: overlay.result,
    onAgain: startSession,
    onDone: () => {
      setOverlay(null);
      setTab('home');
    }
  }), overlay?.kind === 'cardEditor' && /*#__PURE__*/React.createElement(CardEditor, {
    card: overlay.card,
    deckId: overlay.deckId,
    onBack: () => setOverlay(null),
    onSnack: showSnack
  }), overlay?.kind === 'deckEditor' && /*#__PURE__*/React.createElement(DeckEditor, {
    deck: overlay.deck,
    onBack: () => setOverlay(null),
    onSnack: showSnack
  }), overlay?.kind === 'import' && /*#__PURE__*/React.createElement(ImportScreen, {
    onBack: () => setOverlay(null),
    onSnack: showSnack,
    onStudy: startSession
  }), overlay?.kind === 'onboarding' && /*#__PURE__*/React.createElement(OnboardingScreen, {
    onDone: () => setOverlay(null),
    onStartSession: startSession,
    onImport: () => setOverlay({
      kind: 'import'
    })
  }), /*#__PURE__*/React.createElement(PeekSheet, {
    obj: peek,
    onClose: () => setPeek(null),
    onStudy: () => closePeekAnd(() => startSession()),
    onBrowse: () => closePeekAnd(() => setTab('browse')),
    onEdit: () => closePeekAnd(o => o.isCollection ? showSnack('Collection editor — filters, sort & status') : setOverlay({
      kind: 'deckEditor',
      deck: o
    }))
  }), /*#__PURE__*/React.createElement(CreateSheet, {
    open: createOpen,
    onClose: () => setCreateOpen(false),
    onNewCard: () => {
      setCreateOpen(false);
      setOverlay({
        kind: 'cardEditor'
      });
    },
    onNewDeck: () => {
      setCreateOpen(false);
      setOverlay({
        kind: 'deckEditor'
      });
    },
    onNewCollection: () => {
      setCreateOpen(false);
      showSnack('Collection editor — saved smart filters');
    },
    onImport: () => {
      setCreateOpen(false);
      setOverlay({
        kind: 'import'
      });
    }
  }), /*#__PURE__*/React.createElement(StreakSheet, {
    open: streakOpen,
    onClose: () => setStreakOpen(false)
  }), snack && /*#__PURE__*/React.createElement(Snackbar, {
    text: snack
  }));
}
function Root() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '28px 16px',
      boxSizing: 'border-box'
    }
  }, /*#__PURE__*/React.createElement(IOSDevice, null, /*#__PURE__*/React.createElement(MarankiApp, {
    t: t,
    setTweak: setTweak
  })), /*#__PURE__*/React.createElement(TweaksPanel, null, /*#__PURE__*/React.createElement(TweakSection, {
    label: "Theme"
  }), /*#__PURE__*/React.createElement(TweakRadio, {
    label: "Mode",
    value: t.theme,
    options: [{
      value: 'light',
      label: 'Paper'
    }, {
      value: 'dark',
      label: 'Evening'
    }],
    onChange: v => setTweak('theme', v)
  }), /*#__PURE__*/React.createElement(TweakToggle, {
    label: "Paper grain",
    value: t.paperGrain,
    onChange: v => setTweak('paperGrain', v)
  }), /*#__PURE__*/React.createElement(TweakSection, {
    label: "Home"
  }), /*#__PURE__*/React.createElement(TweakRadio, {
    label: "Hero",
    value: t.heroStyle,
    options: [{
      value: 'stack',
      label: 'Card stack'
    }, {
      value: 'command',
      label: 'Command'
    }],
    onChange: v => setTweak('heroStyle', v)
  })));
}
ReactDOM.createRoot(document.getElementById('root')).render(/*#__PURE__*/React.createElement(Root, null));
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/app-v2/app.jsx", error: String((e && e.message) || e) }); }

// ui_kits/app-v2/data.jsx
try { (() => {
/* Maranki App Redesign v2 — sample content.
   Richer than v1: full card objects with SRS fields the screens surface
   (interval, predicted intervals per rating, state), decks incl. inactive +
   imported, collections with honest counts, achievements, heatmap data. */

const QUEUE = [{
  id: 'c1',
  word: 'die Stunde',
  article: 'die',
  base: 'Stunde',
  tr: 'the hour',
  ipa: '/ˈʃtʊndə/',
  ex: 'Wir treffen uns in einer Stunde.',
  exTr: 'We meet in an hour.',
  level: 'A1',
  type: 'noun',
  state: 'due',
  lang: 'de',
  step: null,
  pred: {
    again: 'soon',
    hard: '4d',
    good: '9d',
    easy: '21d'
  }
}, {
  id: 'c2',
  word: 'verstehen',
  article: null,
  base: 'verstehen',
  tr: 'to understand',
  ipa: '/fɛɐ̯ˈʃteːən/',
  ex: 'Ich verstehe dich gut.',
  exTr: 'I understand you well.',
  level: 'A2',
  type: 'verb',
  state: 'due',
  lang: 'de',
  step: null,
  pred: {
    again: 'soon',
    hard: '2d',
    good: '6d',
    easy: '14d'
  }
}, {
  id: 'c3',
  word: 'die Erfahrung',
  article: 'die',
  base: 'Erfahrung',
  tr: 'the experience',
  ipa: '/ɛɐ̯ˈfaːʁʊŋ/',
  ex: 'Sie hat viel Erfahrung.',
  exTr: 'She has a lot of experience.',
  level: 'B1',
  type: 'noun',
  state: 'learning',
  lang: 'de',
  step: '2/2 · 10m → 1d',
  pred: {
    again: 'soon',
    hard: '10m',
    good: '1d',
    easy: '4d'
  }
}, {
  id: 'c4',
  word: 'gemütlich',
  article: null,
  base: 'gemütlich',
  tr: 'cosy, comfortable',
  ipa: '/ɡəˈmyːtlɪç/',
  ex: 'Das Café ist sehr gemütlich.',
  exTr: 'The café is very cosy.',
  level: 'B2',
  type: 'adjective',
  state: 'new',
  lang: 'de',
  step: '1/2 · 1m → 10m',
  pred: {
    again: 'soon',
    hard: '1m',
    good: '10m',
    easy: '4d'
  }
}, {
  id: 'c5',
  word: 'der Vorschlag',
  article: 'der',
  base: 'Vorschlag',
  tr: 'the suggestion',
  ipa: '/ˈfoːɐ̯ʃlaːk/',
  ex: 'Das ist ein guter Vorschlag.',
  exTr: "That's a good suggestion.",
  level: 'B1',
  type: 'noun',
  state: 'due',
  lang: 'de',
  step: null,
  pred: {
    again: 'soon',
    hard: '5d',
    good: '12d',
    easy: '1mo'
  }
}, {
  id: 'c6',
  word: 'aufräumen',
  article: null,
  base: 'aufräumen',
  tr: 'to tidy up',
  ipa: '/ˈaʊ̯fˌʁɔɪ̯mən/',
  ex: 'Ich muss mein Zimmer aufräumen.',
  exTr: 'I have to tidy my room.',
  level: 'A2',
  type: 'verb',
  state: 'due',
  lang: 'de',
  step: null,
  pred: {
    again: 'soon',
    hard: '3d',
    good: '8d',
    easy: '19d'
  }
}];
const LIB = [...QUEUE, {
  id: 'c7',
  word: 'mañana',
  article: null,
  base: 'mañana',
  tr: 'tomorrow; morning',
  ipa: '/maˈɲana/',
  ex: 'Hasta mañana, nos vemos.',
  exTr: 'See you tomorrow.',
  level: 'A1',
  type: 'adverb',
  state: 'mastered',
  lang: 'es',
  interval: '2mo',
  fav: true
}, {
  id: 'c8',
  word: 'el aprendizaje',
  article: 'el',
  base: 'aprendizaje',
  tr: 'the learning',
  ipa: '/apɾendiˈθaxe/',
  ex: 'El aprendizaje nunca termina.',
  exTr: 'Learning never ends.',
  level: 'B1',
  type: 'noun',
  state: 'review',
  lang: 'es',
  interval: '6d'
}, {
  id: 'c9',
  word: 'aprovechar',
  article: null,
  base: 'aprovechar',
  tr: 'to make the most of',
  ipa: '/apɾoβeˈt͡ʃaɾ/',
  ex: 'Hay que aprovechar el tiempo.',
  exTr: 'One must make the most of time.',
  level: 'B2',
  type: 'verb',
  state: 'new',
  lang: 'es'
}, {
  id: 'c10',
  word: 'die Gelegenheit',
  article: 'die',
  base: 'Gelegenheit',
  tr: 'the opportunity',
  ipa: '/ɡəˈleːɡn̩haɪ̯t/',
  ex: 'Das ist eine gute Gelegenheit.',
  exTr: 'That is a good opportunity.',
  level: 'B1',
  type: 'noun',
  state: 'mastered',
  lang: 'de',
  interval: '3mo',
  fav: true
}, {
  id: 'c11',
  word: 'sin embargo',
  article: null,
  base: 'sin embargo',
  tr: 'however',
  ipa: '/sin emˈbaɾɣo/',
  ex: 'Sin embargo, decidió quedarse.',
  exTr: 'However, she decided to stay.',
  level: 'B1',
  type: 'phrase',
  state: 'review',
  lang: 'es',
  interval: '12d'
}, {
  id: 'c12',
  word: 'zuverlässig',
  article: null,
  base: 'zuverlässig',
  tr: 'reliable',
  ipa: '/ˈt͡suːfɛɐ̯ˌlɛsɪç/',
  ex: 'Er ist ein zuverlässiger Kollege.',
  exTr: 'He is a reliable colleague.',
  level: 'B2',
  type: 'adjective',
  state: 'learning',
  lang: 'de'
}];
const DECKS = [{
  id: 'de-a1',
  name: 'German — Everyday',
  flag: '🇩🇪',
  lang: 'German',
  total: 240,
  mastered: 163,
  learning: 22,
  neww: 55,
  due: 14,
  level: 'A1',
  builtin: true,
  active: true
}, {
  id: 'de-b1',
  name: 'German — Conversation',
  flag: '🇩🇪',
  lang: 'German',
  total: 320,
  mastered: 96,
  learning: 40,
  neww: 184,
  due: 9,
  level: 'B1',
  builtin: true,
  active: true
}, {
  id: 'es-5000',
  name: '5000 Spanish Sentences',
  flag: '🇪🇸',
  lang: 'Spanish',
  total: 5000,
  mastered: 210,
  learning: 60,
  neww: 4730,
  due: 3,
  level: null,
  builtin: false,
  active: true
}, {
  id: 'es-travel',
  name: 'Spanish — Travel',
  flag: '🇪🇸',
  lang: 'Spanish',
  total: 180,
  mastered: 74,
  learning: 18,
  neww: 88,
  due: 0,
  level: 'B1',
  builtin: true,
  active: false
}, {
  id: 'fr-a1',
  name: 'French — Basics',
  flag: '🇫🇷',
  lang: 'French',
  total: 150,
  mastered: 0,
  learning: 0,
  neww: 150,
  due: 0,
  level: 'A1',
  builtin: true,
  active: false
}];
const COLLECTIONS = [{
  id: 'hard',
  name: 'Hardest cards',
  icon: 'flame',
  count: 42,
  due: 11,
  desc: 'Lowest ease across decks',
  sort: 'hardest'
}, {
  id: 'fav',
  name: 'Favorites',
  icon: 'heart',
  count: 28,
  due: 4,
  desc: 'Cards you starred',
  sort: 'smart'
}, {
  id: 'daily',
  name: 'Daily practice',
  icon: 'today',
  count: 60,
  due: 11,
  desc: 'Young cards · interval 0–7d',
  sort: 'smart'
}];
const ACHIEVEMENTS = [{
  id: 1,
  name: 'First steps',
  desc: 'Complete your first session',
  icon: 'footsteps',
  cat: 'Study',
  unlocked: true,
  date: 'May 2'
}, {
  id: 2,
  name: 'Week warrior',
  desc: 'Hold a 7-day streak',
  icon: 'flame',
  cat: 'Streak',
  unlocked: true,
  date: 'May 18'
}, {
  id: 3,
  name: 'Centurion',
  desc: 'Master 100 cards',
  icon: 'ribbon',
  cat: 'Mastery',
  unlocked: true,
  date: 'May 24'
}, {
  id: 4,
  name: 'Quick draw',
  desc: '50 fast answers',
  icon: 'flash',
  cat: 'Speed',
  unlocked: true,
  date: 'May 30'
}, {
  id: 5,
  name: 'Fortnight',
  desc: 'Hold a 14-day streak',
  icon: 'calendar',
  cat: 'Streak',
  unlocked: false,
  prog: 12,
  goal: 14
}, {
  id: 6,
  name: 'Scholar',
  desc: 'Master 500 cards',
  icon: 'school',
  cat: 'Mastery',
  unlocked: false,
  prog: 343,
  goal: 500
}, {
  id: 7,
  name: 'Marathon',
  desc: 'Hold a 30-day streak',
  icon: 'trophy',
  cat: 'Streak',
  unlocked: false,
  prog: 12,
  goal: 30
}, {
  id: 8,
  name: 'Polyglot',
  desc: 'Study three languages',
  icon: 'globe',
  cat: 'Study',
  unlocked: false,
  prog: 2,
  goal: 3
}];

/* last 14 days for the streak strip: s=studied, f=frozen, m=missed, t=today */
const DAYS14 = ['s', 's', 's', 'm', 's', 's', 'f', 's', 's', 's', 's', 's', 's', 't'];

/* 5-week heatmap, intensity 0–4, latest week last */
const HEAT = [[1, 2, 0, 3, 1, 2, 2], [2, 3, 1, 0, 2, 4, 1], [0, 2, 3, 2, 1, 2, 3], [2, 1, 2, 4, 3, 0, 2], [3, 2, 1, 2, 4, 3, 1]];
const PERSON = {
  streak: 12,
  best: 23,
  freezes: 2,
  level: 7,
  levelName: 'Wordsmith',
  xp: 2840,
  xpNext: 160,
  masteryPct: 68,
  masteredCards: 843,
  totalCards: 1240,
  retention: 84,
  studiedToday: 17,
  goalReviews: 30,
  doneReviews: 14,
  goalNew: 10,
  doneNew: 3
};
const READY = {
  total: 26,
  due: 18,
  neww: 5,
  learning: 3,
  mins: 10
};
Object.assign(window, {
  QUEUE,
  LIB,
  DECKS,
  COLLECTIONS,
  ACHIEVEMENTS,
  DAYS14,
  HEAT,
  PERSON,
  READY
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/app-v2/data.jsx", error: String((e && e.message) || e) }); }

// ui_kits/app-v2/ios-frame.jsx
try { (() => {
/* BEGIN USAGE */
// iOS.jsx — Simplified iOS 26 (Liquid Glass) device frame
// Based on the iOS 26 UI Kit + Figma status bar spec. No assets, no deps.
// Exports (to window): IOSDevice, IOSStatusBar, IOSNavBar, IOSGlassPill, IOSList, IOSListRow, IOSKeyboard
//
// Usage — wrap your screen content in <IOSDevice> to get the bezel, status bar
// and home indicator (props: title, dark, keyboard):
//
//   <IOSDevice title="Settings">
//     ...your screen content...
//   </IOSDevice>
//   <IOSDevice dark title="Search" keyboard>…</IOSDevice>
/* END USAGE */

// ─────────────────────────────────────────────────────────────
// Status bar
// ─────────────────────────────────────────────────────────────
function IOSStatusBar({
  dark = false,
  time = '9:41'
}) {
  const c = dark ? '#fff' : '#000';
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 154,
      alignItems: 'center',
      justifyContent: 'center',
      padding: '21px 24px 19px',
      boxSizing: 'border-box',
      position: 'relative',
      zIndex: 20,
      width: '100%'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      height: 22,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      paddingTop: 1.5
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: '-apple-system, "SF Pro", system-ui',
      fontWeight: 590,
      fontSize: 17,
      lineHeight: '22px',
      color: c
    }
  }, time)), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      height: 22,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 7,
      paddingTop: 1,
      paddingRight: 1
    }
  }, /*#__PURE__*/React.createElement("svg", {
    width: "19",
    height: "12",
    viewBox: "0 0 19 12"
  }, /*#__PURE__*/React.createElement("rect", {
    x: "0",
    y: "7.5",
    width: "3.2",
    height: "4.5",
    rx: "0.7",
    fill: c
  }), /*#__PURE__*/React.createElement("rect", {
    x: "4.8",
    y: "5",
    width: "3.2",
    height: "7",
    rx: "0.7",
    fill: c
  }), /*#__PURE__*/React.createElement("rect", {
    x: "9.6",
    y: "2.5",
    width: "3.2",
    height: "9.5",
    rx: "0.7",
    fill: c
  }), /*#__PURE__*/React.createElement("rect", {
    x: "14.4",
    y: "0",
    width: "3.2",
    height: "12",
    rx: "0.7",
    fill: c
  })), /*#__PURE__*/React.createElement("svg", {
    width: "17",
    height: "12",
    viewBox: "0 0 17 12"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M8.5 3.2C10.8 3.2 12.9 4.1 14.4 5.6L15.5 4.5C13.7 2.7 11.2 1.5 8.5 1.5C5.8 1.5 3.3 2.7 1.5 4.5L2.6 5.6C4.1 4.1 6.2 3.2 8.5 3.2Z",
    fill: c
  }), /*#__PURE__*/React.createElement("path", {
    d: "M8.5 6.8C9.9 6.8 11.1 7.3 12 8.2L13.1 7.1C11.8 5.9 10.2 5.1 8.5 5.1C6.8 5.1 5.2 5.9 3.9 7.1L5 8.2C5.9 7.3 7.1 6.8 8.5 6.8Z",
    fill: c
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "8.5",
    cy: "10.5",
    r: "1.5",
    fill: c
  })), /*#__PURE__*/React.createElement("svg", {
    width: "27",
    height: "13",
    viewBox: "0 0 27 13"
  }, /*#__PURE__*/React.createElement("rect", {
    x: "0.5",
    y: "0.5",
    width: "23",
    height: "12",
    rx: "3.5",
    stroke: c,
    strokeOpacity: "0.35",
    fill: "none"
  }), /*#__PURE__*/React.createElement("rect", {
    x: "2",
    y: "2",
    width: "20",
    height: "9",
    rx: "2",
    fill: c
  }), /*#__PURE__*/React.createElement("path", {
    d: "M25 4.5V8.5C25.8 8.2 26.5 7.2 26.5 6.5C26.5 5.8 25.8 4.8 25 4.5Z",
    fill: c,
    fillOpacity: "0.4"
  }))));
}

// ─────────────────────────────────────────────────────────────
// Liquid glass pill — blur + tint + shine
// ─────────────────────────────────────────────────────────────
function IOSGlassPill({
  children,
  dark = false,
  style = {}
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      height: 44,
      minWidth: 44,
      borderRadius: 9999,
      position: 'relative',
      overflow: 'hidden',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      boxShadow: dark ? '0 2px 6px rgba(0,0,0,0.35), 0 6px 16px rgba(0,0,0,0.2)' : '0 1px 3px rgba(0,0,0,0.07), 0 3px 10px rgba(0,0,0,0.06)',
      ...style
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      inset: 0,
      borderRadius: 9999,
      backdropFilter: 'blur(12px) saturate(180%)',
      WebkitBackdropFilter: 'blur(12px) saturate(180%)',
      background: dark ? 'rgba(120,120,128,0.28)' : 'rgba(255,255,255,0.5)'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      inset: 0,
      borderRadius: 9999,
      boxShadow: dark ? 'inset 1.5px 1.5px 1px rgba(255,255,255,0.15), inset -1px -1px 1px rgba(255,255,255,0.08)' : 'inset 1.5px 1.5px 1px rgba(255,255,255,0.7), inset -1px -1px 1px rgba(255,255,255,0.4)',
      border: dark ? '0.5px solid rgba(255,255,255,0.15)' : '0.5px solid rgba(0,0,0,0.06)'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative',
      zIndex: 1,
      display: 'flex',
      alignItems: 'center',
      padding: '0 4px'
    }
  }, children));
}

// ─────────────────────────────────────────────────────────────
// Navigation bar — glass pills + large title
// ─────────────────────────────────────────────────────────────
function IOSNavBar({
  title = 'Title',
  dark = false,
  trailingIcon = true
}) {
  const muted = dark ? 'rgba(255,255,255,0.6)' : '#404040';
  const text = dark ? '#fff' : '#000';
  const pillIcon = content => /*#__PURE__*/React.createElement(IOSGlassPill, {
    dark: dark
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 36,
      height: 36,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }
  }, content));
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      paddingTop: 62,
      paddingBottom: 10,
      position: 'relative',
      zIndex: 5
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '0 16px'
    }
  }, pillIcon(/*#__PURE__*/React.createElement("svg", {
    width: "12",
    height: "20",
    viewBox: "0 0 12 20",
    fill: "none",
    style: {
      marginLeft: -1
    }
  }, /*#__PURE__*/React.createElement("path", {
    d: "M10 2L2 10l8 8",
    stroke: muted,
    strokeWidth: "2.5",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }))), trailingIcon && pillIcon(/*#__PURE__*/React.createElement("svg", {
    width: "22",
    height: "6",
    viewBox: "0 0 22 6"
  }, /*#__PURE__*/React.createElement("circle", {
    cx: "3",
    cy: "3",
    r: "2.5",
    fill: muted
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "11",
    cy: "3",
    r: "2.5",
    fill: muted
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "19",
    cy: "3",
    r: "2.5",
    fill: muted
  })))), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '0 16px',
      fontFamily: '-apple-system, system-ui',
      fontSize: 34,
      fontWeight: 700,
      lineHeight: '41px',
      color: text,
      letterSpacing: 0.4
    }
  }, title));
}

// ─────────────────────────────────────────────────────────────
// Grouped list (inset card, r:26) + row (52px)
// ─────────────────────────────────────────────────────────────
function IOSListRow({
  title,
  detail,
  icon,
  chevron = true,
  isLast = false,
  dark = false
}) {
  const text = dark ? '#fff' : '#000';
  const sec = dark ? 'rgba(235,235,245,0.6)' : 'rgba(60,60,67,0.6)';
  const ter = dark ? 'rgba(235,235,245,0.3)' : 'rgba(60,60,67,0.3)';
  const sep = dark ? 'rgba(84,84,88,0.65)' : 'rgba(60,60,67,0.12)';
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      minHeight: 52,
      padding: '0 16px',
      position: 'relative',
      fontFamily: '-apple-system, system-ui',
      fontSize: 17,
      letterSpacing: -0.43
    }
  }, icon && /*#__PURE__*/React.createElement("div", {
    style: {
      width: 30,
      height: 30,
      borderRadius: 7,
      background: icon,
      marginRight: 12,
      flexShrink: 0
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      color: text
    }
  }, title), detail && /*#__PURE__*/React.createElement("span", {
    style: {
      color: sec,
      marginRight: 6
    }
  }, detail), chevron && /*#__PURE__*/React.createElement("svg", {
    width: "8",
    height: "14",
    viewBox: "0 0 8 14",
    style: {
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("path", {
    d: "M1 1l6 6-6 6",
    stroke: ter,
    strokeWidth: "2",
    fill: "none",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  })), !isLast && /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      bottom: 0,
      right: 0,
      left: icon ? 58 : 16,
      height: 0.5,
      background: sep
    }
  }));
}
function IOSList({
  header,
  children,
  dark = false
}) {
  const hc = dark ? 'rgba(235,235,245,0.6)' : 'rgba(60,60,67,0.6)';
  const bg = dark ? '#1C1C1E' : '#fff';
  return /*#__PURE__*/React.createElement("div", null, header && /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: '-apple-system, system-ui',
      fontSize: 13,
      color: hc,
      textTransform: 'uppercase',
      padding: '8px 36px 6px',
      letterSpacing: -0.08
    }
  }, header), /*#__PURE__*/React.createElement("div", {
    style: {
      background: bg,
      borderRadius: 26,
      margin: '0 16px',
      overflow: 'hidden'
    }
  }, children));
}

// ─────────────────────────────────────────────────────────────
// Device frame
// ─────────────────────────────────────────────────────────────
function IOSDevice({
  children,
  width = 402,
  height = 874,
  dark = false,
  title,
  keyboard = false
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      width,
      height,
      borderRadius: 48,
      overflow: 'hidden',
      position: 'relative',
      background: dark ? '#000' : '#F2F2F7',
      boxShadow: '0 40px 80px rgba(0,0,0,0.18), 0 0 0 1px rgba(0,0,0,0.12)',
      fontFamily: '-apple-system, system-ui, sans-serif',
      WebkitFontSmoothing: 'antialiased'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: 11,
      left: '50%',
      transform: 'translateX(-50%)',
      width: 126,
      height: 37,
      borderRadius: 24,
      background: '#000',
      zIndex: 50
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      zIndex: 10
    }
  }, /*#__PURE__*/React.createElement(IOSStatusBar, {
    dark: dark
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      height: '100%',
      display: 'flex',
      flexDirection: 'column'
    }
  }, title !== undefined && /*#__PURE__*/React.createElement(IOSNavBar, {
    title: title,
    dark: dark
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      overflow: 'auto'
    }
  }, children), keyboard && /*#__PURE__*/React.createElement(IOSKeyboard, {
    dark: dark
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
      zIndex: 60,
      height: 34,
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'flex-end',
      paddingBottom: 8,
      pointerEvents: 'none'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 139,
      height: 5,
      borderRadius: 100,
      background: dark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.25)'
    }
  })));
}

// ─────────────────────────────────────────────────────────────
// Keyboard — iOS 26 liquid glass
// ─────────────────────────────────────────────────────────────
function IOSKeyboard({
  dark = false
}) {
  const glyph = dark ? 'rgba(255,255,255,0.7)' : '#595959';
  const sugg = dark ? 'rgba(255,255,255,0.6)' : '#333';
  const keyBg = dark ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.85)';

  // special-key icons
  const icons = {
    shift: /*#__PURE__*/React.createElement("svg", {
      width: "19",
      height: "17",
      viewBox: "0 0 19 17"
    }, /*#__PURE__*/React.createElement("path", {
      d: "M9.5 1L1 9.5h4.5V16h8V9.5H18L9.5 1z",
      fill: glyph
    })),
    del: /*#__PURE__*/React.createElement("svg", {
      width: "23",
      height: "17",
      viewBox: "0 0 23 17"
    }, /*#__PURE__*/React.createElement("path", {
      d: "M7 1h13a2 2 0 012 2v11a2 2 0 01-2 2H7l-6-7.5L7 1z",
      fill: "none",
      stroke: glyph,
      strokeWidth: "1.6",
      strokeLinejoin: "round"
    }), /*#__PURE__*/React.createElement("path", {
      d: "M10 5l7 7M17 5l-7 7",
      stroke: glyph,
      strokeWidth: "1.6",
      strokeLinecap: "round"
    })),
    ret: /*#__PURE__*/React.createElement("svg", {
      width: "20",
      height: "14",
      viewBox: "0 0 20 14"
    }, /*#__PURE__*/React.createElement("path", {
      d: "M18 1v6H4m0 0l4-4M4 7l4 4",
      fill: "none",
      stroke: "#fff",
      strokeWidth: "1.8",
      strokeLinecap: "round",
      strokeLinejoin: "round"
    }))
  };
  const key = (content, {
    w,
    flex,
    ret,
    fs = 25,
    k
  } = {}) => /*#__PURE__*/React.createElement("div", {
    key: k,
    style: {
      height: 42,
      borderRadius: 8.5,
      flex: flex ? 1 : undefined,
      width: w,
      minWidth: 0,
      background: ret ? '#08f' : keyBg,
      boxShadow: '0 1px 0 rgba(0,0,0,0.075)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: '-apple-system, "SF Compact", system-ui',
      fontSize: fs,
      fontWeight: 458,
      color: ret ? '#fff' : glyph
    }
  }, content);
  const row = (keys, pad = 0) => /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 6.5,
      justifyContent: 'center',
      padding: `0 ${pad}px`
    }
  }, keys.map(l => key(l, {
    flex: true,
    k: l
  })));
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative',
      zIndex: 15,
      borderRadius: 27,
      overflow: 'hidden',
      padding: '11px 0 2px',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      boxShadow: dark ? '0 -2px 20px rgba(0,0,0,0.09)' : '0 -1px 6px rgba(0,0,0,0.018), 0 -3px 20px rgba(0,0,0,0.012)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      inset: 0,
      borderRadius: 27,
      backdropFilter: 'blur(12px) saturate(180%)',
      WebkitBackdropFilter: 'blur(12px) saturate(180%)',
      background: dark ? 'rgba(120,120,128,0.14)' : 'rgba(255,255,255,0.25)'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      inset: 0,
      borderRadius: 27,
      boxShadow: dark ? 'inset 1.5px 1.5px 1px rgba(255,255,255,0.15)' : 'inset 1.5px 1.5px 1px rgba(255,255,255,0.7), inset -1px -1px 1px rgba(255,255,255,0.4)',
      border: dark ? '0.5px solid rgba(255,255,255,0.15)' : '0.5px solid rgba(0,0,0,0.06)',
      pointerEvents: 'none'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 20,
      alignItems: 'center',
      padding: '8px 22px 13px',
      width: '100%',
      boxSizing: 'border-box',
      position: 'relative'
    }
  }, ['"The"', 'the', 'to'].map((w, i) => /*#__PURE__*/React.createElement(React.Fragment, {
    key: i
  }, i > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      width: 1,
      height: 25,
      background: '#ccc',
      opacity: 0.3
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      textAlign: 'center',
      fontFamily: '-apple-system, system-ui',
      fontSize: 17,
      color: sugg,
      letterSpacing: -0.43,
      lineHeight: '22px'
    }
  }, w)))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 13,
      padding: '0 6.5px',
      width: '100%',
      boxSizing: 'border-box',
      position: 'relative'
    }
  }, row(['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p']), row(['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'], 20), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 14.25,
      alignItems: 'center'
    }
  }, key(icons.shift, {
    w: 45,
    k: 'shift'
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 6.5,
      flex: 1
    }
  }, ['z', 'x', 'c', 'v', 'b', 'n', 'm'].map(l => key(l, {
    flex: true,
    k: l
  }))), key(icons.del, {
    w: 45,
    k: 'del'
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 6,
      alignItems: 'center'
    }
  }, key('ABC', {
    w: 92.25,
    fs: 18,
    k: 'abc'
  }), key('', {
    flex: true,
    k: 'space'
  }), key(icons.ret, {
    w: 92.25,
    ret: true,
    k: 'ret'
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 56,
      width: '100%',
      position: 'relative'
    }
  }));
}
Object.assign(window, {
  IOSDevice,
  IOSStatusBar,
  IOSNavBar,
  IOSGlassPill,
  IOSList,
  IOSListRow,
  IOSKeyboard
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/app-v2/ios-frame.jsx", error: String((e && e.message) || e) }); }

// ui_kits/app-v2/screen-browse.jsx
try { (() => {
/* Library (Browse) — search, inspect, organize (B1: browse = manage).
   Free-text search with discoverable filter tokens, state-dot ledger rows,
   the universal card peek (audio, example, toggles, pronunciation, edit),
   multi-select with a bulk action bar (B8), and cause-split empty states (B7). */

function BrowseScreen({
  onEditCard,
  onCreate,
  onSnack
}) {
  const {
    useState,
    useMemo
  } = React;
  const [q, setQ] = useState('');
  const [chip, setChip] = useState('all');
  const [peek, setPeek] = useState(null);
  const [selecting, setSelecting] = useState(false);
  const [sel, setSel] = useState([]);
  const [filterOpen, setFilterOpen] = useState(false);
  const cards = useMemo(() => {
    let c = LIB;
    if (chip === 'due') c = c.filter(x => x.state === 'due' || x.state === 'learning');
    if (chip === 'new') c = c.filter(x => x.state === 'new');
    if (chip === 'fav') c = c.filter(x => x.fav);
    if (q) {
      const s = q.toLowerCase();
      c = c.filter(x => x.word.toLowerCase().includes(s) || x.tr.toLowerCase().includes(s) || (x.ex || '').toLowerCase().includes(s));
    }
    return c;
  }, [q, chip]);
  const toggleSel = id => setSel(sel.includes(id) ? sel.filter(x => x !== id) : [...sel, id]);
  const bulk = label => {
    onSnack(`${sel.length} cards ${label}`);
    setSel([]);
    setSelecting(false);
  };
  return /*#__PURE__*/React.createElement(Page, null, /*#__PURE__*/React.createElement(ScreenHead, {
    title: "Library",
    sub: `${PERSON.totalCards.toLocaleString('en-US')} cards across ${DECKS.length} decks`,
    right: selecting ? /*#__PURE__*/React.createElement(Btn, {
      size: "sm",
      kind: "quiet",
      onClick: () => {
        setSelecting(false);
        setSel([]);
      }
    }, "Cancel") : /*#__PURE__*/React.createElement(Btn, {
      size: "sm",
      kind: "quiet",
      onClick: () => setSelecting(true)
    }, "Select")
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 9,
      background: T.card,
      border: `1px solid ${T.hairStrong}`,
      borderRadius: 999,
      padding: '11px 16px',
      marginTop: 12
    }
  }, /*#__PURE__*/React.createElement(Ion, {
    name: "search",
    size: 17,
    color: T.ink3
  }), /*#__PURE__*/React.createElement("input", {
    value: q,
    onChange: e => setQ(e.target.value),
    placeholder: "Search words, meanings, examples\u2026",
    style: {
      flex: 1,
      border: 'none',
      background: 'none',
      fontFamily: T.sans,
      fontSize: 14.5,
      color: T.ink
    }
  }), q && /*#__PURE__*/React.createElement(Ion, {
    name: "close-circle",
    size: 17,
    color: T.ink3,
    style: {
      cursor: 'pointer'
    },
    onClick: () => setQ('')
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.mono,
      fontSize: 11.5,
      color: T.ink3,
      margin: '8px 2px 0'
    }
  }, "try ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: T.pine
    }
  }, "level:B1"), " \xB7 ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: T.pine
    }
  }, "type:verb"), " \xB7 ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: T.pine
    }
  }, "deck:\"Spanish \u2014 Travel\"")), /*#__PURE__*/React.createElement("div", {
    className: "mk-scroll",
    style: {
      display: 'flex',
      gap: 8,
      overflowX: 'auto',
      padding: '14px 0 2px'
    }
  }, /*#__PURE__*/React.createElement(Chip, {
    active: chip === 'all',
    onClick: () => setChip('all')
  }, "All cards"), /*#__PURE__*/React.createElement(Chip, {
    active: chip === 'due',
    icon: "time-outline",
    onClick: () => setChip('due')
  }, "Due"), /*#__PURE__*/React.createElement(Chip, {
    active: chip === 'new',
    icon: "sparkles-outline",
    onClick: () => setChip('new')
  }, "New"), /*#__PURE__*/React.createElement(Chip, {
    active: chip === 'fav',
    icon: "heart-outline",
    onClick: () => setChip('fav')
  }, "Favorites"), /*#__PURE__*/React.createElement(Chip, {
    icon: "options-outline",
    onClick: () => setFilterOpen(true)
  }, "Filters")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: '12px 0 2px'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: T.sans,
      fontSize: 12.5,
      color: T.ink3,
      fontFeatureSettings: "'tnum' 1",
      whiteSpace: 'nowrap'
    }
  }, cards.length, " ", cards.length === 1 ? 'card' : 'cards', " \xB7 sorted smart"), /*#__PURE__*/React.createElement("button", {
    onClick: () => onSnack('Sort — smart · A–Z · newest · hardest'),
    style: {
      background: 'none',
      border: 'none',
      cursor: 'pointer',
      fontFamily: T.sans,
      fontSize: 12.5,
      fontWeight: 700,
      color: T.pine,
      display: 'flex',
      gap: 4,
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement(Ion, {
    name: "swap-vertical",
    size: 13
  }), "Sort")), cards.length === 0 ? /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: 'center',
      padding: '46px 20px'
    }
  }, /*#__PURE__*/React.createElement(Ion, {
    name: "search",
    size: 34,
    color: T.ink3
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.serif,
      fontSize: 19,
      color: T.ink,
      margin: '12px 0 5px'
    }
  }, "No matches", q ? ` for “${q}”` : ''), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontSize: 13.5,
      color: T.ink3,
      marginBottom: 16
    }
  }, "Your cards are still here \u2014 the current search and filters exclude them."), /*#__PURE__*/React.createElement(Btn, {
    kind: "secondary",
    onClick: () => {
      setQ('');
      setChip('all');
    }
  }, "Clear search & filters")) : /*#__PURE__*/React.createElement("div", null, cards.map((c, i) => /*#__PURE__*/React.createElement(Row, {
    key: c.id,
    pad: "13px 0",
    last: i === cards.length - 1,
    onClick: () => selecting ? toggleSel(c.id) : setPeek(c)
  }, selecting && /*#__PURE__*/React.createElement("div", {
    style: {
      width: 22,
      height: 22,
      borderRadius: 7,
      flex: 'none',
      boxSizing: 'border-box',
      border: sel.includes(c.id) ? 'none' : `1.5px solid ${T.hairStrong}`,
      background: sel.includes(c.id) ? T.pine : 'transparent',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }
  }, sel.includes(c.id) && /*#__PURE__*/React.createElement(Ion, {
    name: "checkmark",
    size: 14,
    color: "#fff"
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: T.serif,
      fontWeight: 600,
      fontSize: 17.5,
      color: T.ink,
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis'
    }
  }, c.word), /*#__PURE__*/React.createElement(StateDot, {
    state: c.state
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontSize: 13,
      color: T.ink2,
      marginTop: 1
    }
  }, c.tr)), /*#__PURE__*/React.createElement(LevelBadge, {
    level: c.level
  }), c.fav ? /*#__PURE__*/React.createElement(Ion, {
    name: "heart",
    size: 16,
    color: T.danger
  }) : c.interval ? /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: T.mono,
      fontSize: 11.5,
      color: T.ink3,
      minWidth: 28,
      textAlign: 'right'
    }
  }, c.interval) : /*#__PURE__*/React.createElement("span", {
    style: {
      minWidth: 16
    }
  })))), !selecting && /*#__PURE__*/React.createElement(FAB, {
    onClick: onCreate
  }), selecting && sel.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      left: 14,
      right: 14,
      bottom: TABH + 12,
      zIndex: 55,
      background: T.inverseSurface,
      borderRadius: 16,
      padding: '11px 14px',
      boxShadow: T.shLg,
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      animation: 'snackIn .22s cubic-bezier(0.22,1,0.36,1)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: T.sans,
      fontWeight: 750,
      fontSize: 13.5,
      color: T.inverseText,
      marginRight: 4,
      fontFeatureSettings: "'tnum' 1"
    }
  }, sel.length), [['heart-outline', 'favorited', 'Favorite'], ['flag-outline', 'flagged', 'Flag'], ['eye-off-outline', 'suspended', 'Suspend']].map(([ic, verb, label]) => /*#__PURE__*/React.createElement("button", {
    key: ic,
    title: label,
    onClick: () => bulk(verb),
    style: {
      flex: 1,
      background: 'rgba(255,255,255,0.1)',
      border: 'none',
      borderRadius: 10,
      padding: '8px 0',
      cursor: 'pointer',
      display: 'flex',
      justifyContent: 'center'
    }
  }, /*#__PURE__*/React.createElement(Ion, {
    name: ic,
    size: 17,
    color: T.inverseText
  }))), /*#__PURE__*/React.createElement("button", {
    onClick: () => bulk('queued to study'),
    style: {
      flex: 1.6,
      background: T.inverseAccent,
      border: 'none',
      borderRadius: 10,
      padding: '8px 0',
      cursor: 'pointer',
      fontFamily: T.sans,
      fontWeight: 800,
      fontSize: 12.5,
      color: '#3A2A08'
    }
  }, "Study these")), /*#__PURE__*/React.createElement(CardPeek, {
    card: peek,
    onClose: () => setPeek(null),
    onEdit: () => {
      const c = peek;
      setPeek(null);
      onEditCard(c);
    },
    onSnack: onSnack
  }), /*#__PURE__*/React.createElement(Sheet, {
    open: filterOpen,
    onClose: () => setFilterOpen(false),
    title: "Filters"
  }, /*#__PURE__*/React.createElement(Overline, {
    style: {
      marginBottom: 8
    }
  }, "Level"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 7,
      flexWrap: 'wrap',
      marginBottom: 16
    }
  }, ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'].map(l => /*#__PURE__*/React.createElement(Chip, {
    key: l
  }, l))), /*#__PURE__*/React.createElement(Overline, {
    style: {
      marginBottom: 8
    }
  }, "Status"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 7,
      flexWrap: 'wrap',
      marginBottom: 16
    }
  }, ['New', 'Learning', 'Due', 'Mastered', 'Suspended', 'Flagged'].map(s => /*#__PURE__*/React.createElement(Chip, {
    key: s
  }, s))), /*#__PURE__*/React.createElement(Overline, {
    style: {
      marginBottom: 8
    }
  }, "Deck"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 7,
      flexWrap: 'wrap',
      marginBottom: 20
    }
  }, DECKS.map(d => /*#__PURE__*/React.createElement(Chip, {
    key: d.id
  }, d.flag, " ", d.name))), /*#__PURE__*/React.createElement(Btn, {
    full: true,
    onClick: () => setFilterOpen(false)
  }, "Show results")));
}

/* ——— card peek — the universal card detail ——— */
function CardPeek({
  card,
  onClose,
  onEdit,
  onSnack
}) {
  if (!card) return null;
  return /*#__PURE__*/React.createElement(Sheet, {
    open: !!card,
    onClose: onClose
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'flex-start',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.serif,
      fontWeight: 600,
      fontSize: 28,
      letterSpacing: '-0.015em',
      color: T.ink,
      lineHeight: 1.1
    }
  }, card.word), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.mono,
      fontSize: 13,
      color: T.ink3,
      marginTop: 5,
      whiteSpace: 'nowrap'
    }
  }, card.ipa)), /*#__PURE__*/React.createElement(IconBtn, {
    icon: "volume-high-outline",
    size: 38,
    iconSize: 19,
    color: T.pine,
    bg: T.pineTint,
    onClick: () => onSnack(`Playing “${card.word}”`)
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontWeight: 650,
      fontSize: 17,
      color: T.ink,
      margin: '12px 0 2px'
    }
  }, card.tr), card.ex && /*#__PURE__*/React.createElement("div", {
    style: {
      margin: '10px 0 0'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.serif,
      fontStyle: 'italic',
      fontSize: 15.5,
      color: T.ink2,
      lineHeight: 1.45
    }
  }, card.ex), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontSize: 12.5,
      color: T.ink3,
      marginTop: 2
    }
  }, card.exTr)), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      alignItems: 'center',
      margin: '14px 0 4px',
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement(StateBadge, {
    state: card.state,
    label: card.state
  }), /*#__PURE__*/React.createElement(LevelBadge, {
    level: card.level
  }), /*#__PURE__*/React.createElement(Pill, null, card.type), card.interval && /*#__PURE__*/React.createElement(Pill, {
    mono: true
  }, "next in ", card.interval)), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      margin: '16px 0'
    }
  }, [['heart-outline', 'Favorite'], ['school-outline', 'Learning'], ['checkmark-circle-outline', 'Learned']].map(([ic, label]) => /*#__PURE__*/React.createElement("button", {
    key: label,
    onClick: () => onSnack(`Marked ${label.toLowerCase()}`),
    style: {
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 4,
      background: T.paperSunk,
      border: 'none',
      borderRadius: 12,
      padding: '11px 0',
      cursor: 'pointer'
    }
  }, /*#__PURE__*/React.createElement(Ion, {
    name: ic,
    size: 18,
    color: T.ink2
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: T.sans,
      fontSize: 11.5,
      fontWeight: 650,
      color: T.ink2
    }
  }, label)))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement(Btn, {
    kind: "secondary",
    full: true,
    icon: "mic-outline",
    onClick: () => onSnack('Pronunciation practice — record & compare')
  }, "Say it"), /*#__PURE__*/React.createElement(Btn, {
    full: true,
    icon: "pencil",
    onClick: onEdit
  }, "Edit card")));
}
Object.assign(window, {
  BrowseScreen,
  CardPeek
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/app-v2/screen-browse.jsx", error: String((e && e.message) || e) }); }

// ui_kits/app-v2/screen-complete.jsx
try { (() => {
/* Session complete — the payout, then momentum (A2 + C1).
   The reward is one skippable layer: everything renders at once with a
   staggered rise; "Done for today" is always one tap away. XP is itemized
   and counts up, the level bar fills, achievements pop — then the
   "keep going" hub offers study-ahead / hardest / cram instead of a wall. */

function StatTile({
  value,
  label,
  accent
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      textAlign: 'center',
      padding: '14px 4px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontWeight: 800,
      fontSize: 26,
      letterSpacing: '-0.02em',
      color: accent || T.ink,
      fontFeatureSettings: "'tnum' 1"
    }
  }, value), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontSize: 12,
      fontWeight: 650,
      color: T.ink3,
      marginTop: 2
    }
  }, label));
}
function CompleteScreen({
  result,
  deckName = 'German — Everyday',
  onAgain,
  onDone
}) {
  const {
    useState,
    useEffect
  } = React;
  const counts = result?.counts || {
    again: 1,
    hard: 1,
    good: 3,
    easy: 2
  };
  const total = result?.total || 7;
  const correct = total - counts.again;
  const acc = Math.round(correct / total * 100);
  const xpItems = [{
    label: `${total} cards reviewed`,
    xp: total * 2
  }, {
    label: `${correct} correct`,
    xp: correct * 2
  }, {
    label: 'Daily streak · day 12',
    xp: 10
  }, {
    label: `${result?.bestRun || 5} in a row`,
    xp: 8
  }];
  const xpTotal = xpItems.reduce((s, i) => s + i.xp, 0);
  const [xpShown, setXpShown] = useState(0);
  useEffect(() => {
    let n = 0;
    const t = setInterval(() => {
      n += Math.ceil(xpTotal / 24);
      if (n >= xpTotal) {
        n = xpTotal;
        clearInterval(t);
      }
      setXpShown(n);
    }, 40);
    return () => clearInterval(t);
  }, []);
  const tier = acc >= 90 ? ['Brilliant session.', 'Your recall is razor-sharp today.'] : acc >= 70 ? ['Strong recall today.', 'Your retention is climbing.'] : ['Good, honest work.', 'The misses will come back soon — that’s the system working.'];
  const seg = (n, color) => total ? /*#__PURE__*/React.createElement("div", {
    style: {
      width: `${n / total * 100}%`,
      background: color
    }
  }) : null;
  return /*#__PURE__*/React.createElement("div", {
    className: "mk-scroll",
    style: {
      position: 'absolute',
      inset: 0,
      background: T.paper,
      zIndex: 50,
      overflowY: 'auto',
      padding: `0 22px 30px`,
      boxSizing: 'border-box'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: `${TOPPAD + 18}px 0 0`,
      textAlign: 'center',
      animation: 'riseIn .35s cubic-bezier(0.22,1,0.36,1)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 54,
      height: 54,
      borderRadius: 999,
      background: T.pineTint,
      margin: '0 auto 14px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }
  }, /*#__PURE__*/React.createElement(Ion, {
    name: "checkmark",
    size: 28,
    color: T.pine
  })), /*#__PURE__*/React.createElement(Overline, null, "Session complete \xB7 ", deckName), /*#__PURE__*/React.createElement("h1", {
    style: {
      margin: '10px 0 6px',
      fontFamily: T.serif,
      fontWeight: 600,
      fontSize: 30,
      letterSpacing: '-0.02em',
      color: T.ink
    }
  }, tier[0]), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontSize: 14.5,
      color: T.ink2
    }
  }, tier[1])), /*#__PURE__*/React.createElement(Card, {
    style: {
      marginTop: 22,
      padding: '4px 8px',
      display: 'flex',
      animation: 'riseIn .4s .05s cubic-bezier(0.22,1,0.36,1) backwards'
    }
  }, /*#__PURE__*/React.createElement(StatTile, {
    value: total,
    label: "Cards"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      width: 1,
      background: T.hairSoft,
      margin: '14px 0'
    }
  }), /*#__PURE__*/React.createElement(StatTile, {
    value: `${acc}%`,
    label: "Accuracy",
    accent: T.pine
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      width: 1,
      background: T.hairSoft,
      margin: '14px 0'
    }
  }), /*#__PURE__*/React.createElement(StatTile, {
    value: "4:12",
    label: "Time"
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 18,
      animation: 'riseIn .4s .1s cubic-bezier(0.22,1,0.36,1) backwards'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      height: 6,
      borderRadius: 999,
      overflow: 'hidden',
      gap: 1,
      background: T.paperSunk
    }
  }, seg(counts.again, T.rateAgain), seg(counts.hard, T.rateHard), seg(counts.good, T.rateGood), seg(counts.easy, T.rateEasy)), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      marginTop: 8,
      fontFamily: T.sans,
      fontSize: 12,
      color: T.ink3
    }
  }, [['Again', counts.again, T.rateAgain], ['Hard', counts.hard, T.rateHard], ['Good', counts.good, T.rateGood], ['Easy', counts.easy, T.rateEasy]].map(([l, n, c]) => /*#__PURE__*/React.createElement("span", {
    key: l,
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 7,
      height: 7,
      borderRadius: 999,
      background: c,
      display: 'inline-block'
    }
  }), l, " ", /*#__PURE__*/React.createElement("b", {
    style: {
      color: T.ink2,
      fontFeatureSettings: "'tnum' 1"
    }
  }, n)))), counts.again > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.serif,
      fontStyle: 'italic',
      fontSize: 14,
      color: T.ink2,
      marginTop: 10,
      textAlign: 'center'
    }
  }, counts.again, " ", counts.again === 1 ? 'lapse' : 'lapses', " \u2014 ", counts.again === 1 ? 'it' : 'they', "\u2019ll come back soon.")), /*#__PURE__*/React.createElement(Card, {
    style: {
      marginTop: 18,
      animation: 'riseIn .4s .15s cubic-bezier(0.22,1,0.36,1) backwards'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 10
    }
  }, /*#__PURE__*/React.createElement(Overline, null, "Experience"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: T.sans,
      fontWeight: 800,
      fontSize: 20,
      color: T.amberDeep,
      fontFeatureSettings: "'tnum' 1",
      whiteSpace: 'nowrap'
    }
  }, "+", xpShown, " XP")), xpItems.map((it, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      padding: '7px 0',
      borderBottom: i < xpItems.length - 1 ? `1px solid ${T.hairSoft}` : 'none'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: T.sans,
      fontSize: 13.5,
      color: T.ink2
    }
  }, it.label), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: T.mono,
      fontSize: 12.5,
      color: T.ink3
    }
  }, "+", it.xp))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      marginBottom: 7
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: T.sans,
      fontWeight: 700,
      fontSize: 13,
      color: T.ink
    }
  }, "Level ", PERSON.level, " \xB7 ", PERSON.levelName), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: T.mono,
      fontSize: 12,
      color: T.ink3
    }
  }, PERSON.xpNext - Math.min(xpShown, PERSON.xpNext - 10), " XP to level ", PERSON.level + 1)), /*#__PURE__*/React.createElement(Bar, {
    value: 62 + xpShown / xpTotal * 18,
    color: T.amber,
    h: 6
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 14,
      display: 'flex',
      alignItems: 'center',
      gap: 13,
      background: T.amberTint,
      borderRadius: 16,
      padding: '13px 16px',
      animation: 'popIn .4s .5s cubic-bezier(0.34,1.56,0.64,1) backwards'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 42,
      height: 42,
      borderRadius: 12,
      background: T.amber,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flex: 'none'
    }
  }, /*#__PURE__*/React.createElement(Ion, {
    name: "flash",
    size: 21,
    color: "#fff"
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontWeight: 750,
      fontSize: 14.5,
      color: T.ink
    }
  }, "Achievement \u2014 Quick draw"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontSize: 12.5,
      color: T.ink2
    }
  }, "50 fast answers \xB7 +1 streak freeze earned"))), /*#__PURE__*/React.createElement(SectionHead, null, "Keep going"), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(Row, {
    onClick: onAgain,
    pad: "13px 0"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 34,
      height: 34,
      borderRadius: 10,
      background: T.pineTint,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flex: 'none'
    }
  }, /*#__PURE__*/React.createElement(Ion, {
    name: "play-forward",
    size: 16,
    color: T.pine
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontWeight: 700,
      fontSize: 14.5,
      color: T.ink
    }
  }, "Study ahead"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontSize: 12.5,
      color: T.ink3
    }
  }, "12 cards due tomorrow \xB7 an extra pass")), /*#__PURE__*/React.createElement(Ion, {
    name: "chevron-forward",
    size: 16,
    color: T.ink3
  })), /*#__PURE__*/React.createElement(Row, {
    onClick: onAgain,
    pad: "13px 0"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 34,
      height: 34,
      borderRadius: 10,
      background: T.dangerTint,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flex: 'none'
    }
  }, /*#__PURE__*/React.createElement(Ion, {
    name: "flame",
    size: 16,
    color: T.danger
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontWeight: 700,
      fontSize: 14.5,
      color: T.ink
    }
  }, "Review hardest"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontSize: 12.5,
      color: T.ink3
    }
  }, "11 lowest-ease cards across decks")), /*#__PURE__*/React.createElement(Ion, {
    name: "chevron-forward",
    size: 16,
    color: T.ink3
  })), /*#__PURE__*/React.createElement(Row, {
    onClick: onAgain,
    pad: "13px 0",
    last: true
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 34,
      height: 34,
      borderRadius: 10,
      background: T.infoTint,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flex: 'none'
    }
  }, /*#__PURE__*/React.createElement(Ion, {
    name: "shuffle",
    size: 16,
    color: T.info
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontWeight: 700,
      fontSize: 14.5,
      color: T.ink
    }
  }, "Cram this deck"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontSize: 12.5,
      color: T.ink3
    }
  }, "Free practice \u2014 never changes your schedule")), /*#__PURE__*/React.createElement(Ion, {
    name: "chevron-forward",
    size: 16,
    color: T.ink3
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 20
    }
  }, /*#__PURE__*/React.createElement(Btn, {
    full: true,
    size: "lg",
    onClick: onDone
  }, "Done for today")));
}
Object.assign(window, {
  CompleteScreen,
  StatTile
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/app-v2/screen-complete.jsx", error: String((e && e.message) || e) }); }

// ui_kits/app-v2/screen-editors.jsx
try { (() => {
/* Editors — card & deck, with safety built in (B9, C4).
   Unsaved-changes guard on back, Save disabled until valid, a real
   Pronunciation section (IPA + record/playback — the unmounted subsystem,
   surfaced), and a deck delete that offers keep / move / delete-all. */

function CardEditor({
  card,
  deckId,
  onBack,
  onSnack
}) {
  const {
    useState
  } = React;
  const editing = !!card;
  const [word, setWord] = useState(card?.word || '');
  const [tr, setTr] = useState(card?.tr || '');
  const [ex, setEx] = useState(card?.ex || '');
  const [ipa, setIpa] = useState(card?.ipa || '');
  const [level, setLevel] = useState(card?.level || null);
  const [type, setType] = useState(card?.type || null);
  const [deck, setDeck] = useState(card ? 'de-a1' : deckId || 'de-a1');
  const [recorded, setRecorded] = useState(editing);
  const [recording, setRecording] = useState(false);
  const [guard, setGuard] = useState(false);
  const dirty = editing ? word !== card.word || tr !== card.tr || ex !== (card.ex || '') || ipa !== (card.ipa || '') : word || tr || ex || ipa;
  const valid = word.trim() && tr.trim();
  const record = () => {
    setRecording(true);
    setTimeout(() => {
      setRecording(false);
      setRecorded(true);
    }, 1500);
  };
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      inset: 0,
      background: T.paper,
      zIndex: 55
    }
  }, /*#__PURE__*/React.createElement(StackBar, {
    title: editing ? 'Edit card' : 'New card',
    backIcon: "close",
    onBack: () => dirty ? setGuard(true) : onBack(),
    right: /*#__PURE__*/React.createElement(Btn, {
      size: "sm",
      disabled: !valid,
      onClick: () => {
        onSnack(editing ? 'Card saved' : `“${word}” added`);
        onBack();
      }
    }, "Save")
  }), /*#__PURE__*/React.createElement("div", {
    className: "mk-scroll",
    style: {
      position: 'absolute',
      top: TOPPAD + 48,
      bottom: 0,
      left: 0,
      right: 0,
      overflowY: 'auto',
      padding: '18px 20px 40px'
    }
  }, /*#__PURE__*/React.createElement(Field, {
    label: "Word *",
    value: word,
    onChange: setWord,
    placeholder: "die Stunde",
    autoFocus: !editing
  }), /*#__PURE__*/React.createElement(Field, {
    label: "Translation *",
    value: tr,
    onChange: setTr,
    placeholder: "the hour"
  }), /*#__PURE__*/React.createElement(Field, {
    label: "Example",
    value: ex,
    onChange: setEx,
    placeholder: "Wir treffen uns in einer Stunde.",
    multiline: true,
    hint: "Shown in italic on the card back \u2014 real language, quoted."
  }), /*#__PURE__*/React.createElement(Overline, {
    style: {
      margin: '4px 0 7px'
    }
  }, "Pronunciation"), /*#__PURE__*/React.createElement("div", {
    style: {
      background: T.card,
      border: `1px solid ${T.hairStrong}`,
      borderRadius: 12,
      padding: '12px 14px',
      marginBottom: 16
    }
  }, /*#__PURE__*/React.createElement("input", {
    value: ipa,
    onChange: e => setIpa(e.target.value),
    placeholder: "/\u02C8\u0283t\u028And\u0259/ (IPA, optional)",
    style: {
      width: '100%',
      border: 'none',
      background: 'none',
      fontFamily: T.mono,
      fontSize: 14.5,
      color: T.ink,
      boxSizing: 'border-box'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 9,
      marginTop: 12,
      paddingTop: 12,
      borderTop: `1px solid ${T.hairSoft}`
    }
  }, recording ? /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 8,
      fontFamily: T.sans,
      fontSize: 13.5,
      fontWeight: 700,
      color: T.danger
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 9,
      height: 9,
      borderRadius: 99,
      background: T.danger,
      animation: 'pulseSoft 1s infinite'
    }
  }), "Recording\u2026 tap to stop") : recorded ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(IconBtn, {
    icon: "play",
    size: 32,
    iconSize: 15,
    color: T.pine,
    bg: T.pineTint
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      fontFamily: T.sans,
      fontSize: 13,
      color: T.ink2
    }
  }, "Your recording \xB7 0:02"), /*#__PURE__*/React.createElement(Btn, {
    size: "sm",
    kind: "quiet",
    icon: "mic-outline",
    onClick: record
  }, "Re-record")) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(Btn, {
    size: "sm",
    kind: "secondary",
    icon: "mic-outline",
    onClick: record
  }, "Record yourself"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: T.sans,
      fontSize: 12,
      color: T.ink3
    }
  }, "compare with the native audio")))), /*#__PURE__*/React.createElement(Overline, {
    style: {
      margin: '4px 0 7px'
    }
  }, "Deck"), /*#__PURE__*/React.createElement("div", {
    className: "mk-scroll",
    style: {
      display: 'flex',
      gap: 7,
      overflowX: 'auto',
      marginBottom: 16
    }
  }, DECKS.filter(d => d.active).map(d => /*#__PURE__*/React.createElement(Chip, {
    key: d.id,
    active: deck === d.id,
    onClick: () => setDeck(d.id)
  }, d.flag, " ", d.name))), /*#__PURE__*/React.createElement(Overline, {
    style: {
      margin: '4px 0 7px'
    }
  }, "Level"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 7,
      marginBottom: 16
    }
  }, ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'].map(l => /*#__PURE__*/React.createElement(Chip, {
    key: l,
    active: level === l,
    onClick: () => setLevel(level === l ? null : l)
  }, l))), /*#__PURE__*/React.createElement(Overline, {
    style: {
      margin: '4px 0 7px'
    }
  }, "Type"), /*#__PURE__*/React.createElement("div", {
    className: "mk-scroll",
    style: {
      display: 'flex',
      gap: 7,
      overflowX: 'auto',
      marginBottom: 20
    }
  }, ['noun', 'verb', 'adjective', 'adverb', 'phrase', 'preposition', 'other'].map(t => /*#__PURE__*/React.createElement(Chip, {
    key: t,
    active: type === t,
    onClick: () => setType(type === t ? null : t)
  }, t))), editing && /*#__PURE__*/React.createElement("div", {
    style: {
      border: `1px solid ${softTint(T.danger, 30)}`,
      borderRadius: 14,
      padding: '2px 14px',
      background: softTint(T.danger, 4),
      marginTop: 8
    }
  }, /*#__PURE__*/React.createElement(ListRow, {
    icon: "trash-outline",
    danger: true,
    title: "Delete this card",
    sub: "Its scheduling history goes with it",
    last: true,
    onClick: () => {
      onSnack(`“${card.word}” deleted`);
      onBack();
    }
  }))), /*#__PURE__*/React.createElement(Sheet, {
    open: guard,
    onClose: () => setGuard(false),
    title: "Discard changes?"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontSize: 14.5,
      color: T.ink2,
      marginBottom: 18
    }
  }, "Your edits to this card haven\u2019t been saved."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement(Btn, {
    kind: "secondary",
    full: true,
    onClick: () => setGuard(false)
  }, "Keep editing"), /*#__PURE__*/React.createElement(Btn, {
    kind: "danger",
    full: true,
    onClick: () => {
      setGuard(false);
      onBack();
    }
  }, "Discard"))));
}
function DeckEditor({
  deck,
  onBack,
  onSnack
}) {
  const {
    useState
  } = React;
  const editing = !!deck;
  const [name, setName] = useState(deck?.name || '');
  const [lang, setLang] = useState(deck?.lang || null);
  const [desc, setDesc] = useState('');
  const [delOpen, setDelOpen] = useState(false);
  const [delMode, setDelMode] = useState('move');
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      inset: 0,
      background: T.paper,
      zIndex: 55
    }
  }, /*#__PURE__*/React.createElement(StackBar, {
    title: editing ? 'Edit deck' : 'New deck',
    backIcon: "close",
    onBack: onBack,
    right: /*#__PURE__*/React.createElement(Btn, {
      size: "sm",
      disabled: !name.trim(),
      onClick: () => {
        onSnack(editing ? 'Deck saved' : `Deck “${name}” created`);
        onBack();
      }
    }, "Save")
  }), /*#__PURE__*/React.createElement("div", {
    className: "mk-scroll",
    style: {
      position: 'absolute',
      top: TOPPAD + 48,
      bottom: 0,
      left: 0,
      right: 0,
      overflowY: 'auto',
      padding: '18px 20px 40px'
    }
  }, /*#__PURE__*/React.createElement(Field, {
    label: "Deck name *",
    value: name,
    onChange: setName,
    placeholder: "Spanish \u2014 Kitchen verbs",
    autoFocus: !editing
  }), /*#__PURE__*/React.createElement(Overline, {
    style: {
      margin: '4px 0 7px'
    }
  }, "Language"), /*#__PURE__*/React.createElement("div", {
    className: "mk-scroll",
    style: {
      display: 'flex',
      gap: 7,
      overflowX: 'auto',
      marginBottom: 16
    }
  }, ['German', 'Spanish', 'French', 'Italian', 'Other'].map(l => /*#__PURE__*/React.createElement(Chip, {
    key: l,
    active: lang === l,
    onClick: () => setLang(l)
  }, l))), /*#__PURE__*/React.createElement(Field, {
    label: "Description",
    value: desc,
    onChange: setDesc,
    placeholder: "What lives in this deck?",
    multiline: true
  }), editing && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(Btn, {
    kind: "secondary",
    full: true,
    icon: "copy-outline",
    style: {
      marginTop: 4
    },
    onClick: () => {
      onSnack(`Copied as “${deck.name} (copy)” — fresh cards, no progress`);
    }
  }, "Duplicate deck"), /*#__PURE__*/React.createElement("div", {
    style: {
      border: `1px solid ${softTint(T.danger, 30)}`,
      borderRadius: 14,
      padding: '2px 14px',
      background: softTint(T.danger, 4),
      marginTop: 18
    }
  }, /*#__PURE__*/React.createElement(ListRow, {
    icon: "trash-outline",
    danger: true,
    title: "Delete this deck",
    sub: `${deck.total.toLocaleString('en-US')} cards — choose what happens to them`,
    last: true,
    onClick: () => setDelOpen(true)
  })))), /*#__PURE__*/React.createElement(Sheet, {
    open: delOpen,
    onClose: () => setDelOpen(false),
    title: `Delete “${deck?.name}”?`
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontSize: 14,
      color: T.ink2,
      marginBottom: 14
    }
  }, "What should happen to its ", deck?.total.toLocaleString('en-US'), " cards?"), [{
    id: 'move',
    icon: 'arrow-redo-outline',
    t: 'Move cards to another deck',
    s: 'Keeps every card and its progress'
  }, {
    id: 'keep',
    icon: 'archive-outline',
    t: 'Keep cards, remove the deck',
    s: 'Cards stay in your library, unassigned'
  }, {
    id: 'all',
    icon: 'trash-outline',
    t: 'Delete deck and all its cards',
    s: 'Permanent — scheduling history is lost'
  }].map(o => /*#__PURE__*/React.createElement(Row, {
    key: o.id,
    onClick: () => setDelMode(o.id),
    pad: "11px 0"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 20,
      height: 20,
      borderRadius: 99,
      flex: 'none',
      boxSizing: 'border-box',
      border: delMode === o.id ? `6px solid ${o.id === 'all' ? T.danger : T.pine}` : `1.5px solid ${T.hairStrong}`
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontWeight: 650,
      fontSize: 14,
      color: o.id === 'all' ? T.danger : T.ink
    }
  }, o.t), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontSize: 12.5,
      color: T.ink3
    }
  }, o.s)))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 10,
      marginTop: 14
    }
  }, /*#__PURE__*/React.createElement(Btn, {
    kind: "secondary",
    full: true,
    onClick: () => setDelOpen(false)
  }, "Cancel"), /*#__PURE__*/React.createElement(Btn, {
    kind: delMode === 'all' ? 'dangerSolid' : 'primary',
    full: true,
    onClick: () => {
      setDelOpen(false);
      onSnack(delMode === 'all' ? 'Deck and cards deleted' : 'Deck deleted — cards kept');
      onBack();
    }
  }, delMode === 'all' ? 'Delete everything' : 'Delete deck'))));
}
Object.assign(window, {
  CardEditor,
  DeckEditor
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/app-v2/screen-editors.jsx", error: String((e && e.message) || e) }); }

// ui_kits/app-v2/screen-home.jsx
try { (() => {
/* Home — the daily ritual page.
   One stateful "Today" command (D1): the actual first card of today's queue
   sits on the page as a physical invitation — tap the stack or the command
   to go straight into the session (not the hub). Honest breakdown, daily-goal
   ledger, streak chip with visible freezes, launchable deck rows (D4). */

function HomeScreen({
  onStartSession,
  onPeekDeck,
  onStudyDeck,
  onManage,
  theme,
  onToggleTheme,
  onOpenStreak,
  heroStyle = 'stack'
}) {
  const first = QUEUE[0];
  return /*#__PURE__*/React.createElement(Page, null, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: `${TOPPAD + 8}px 0 0`
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between'
    }
  }, /*#__PURE__*/React.createElement(Overline, null, "Tuesday \xB7 June 9"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement(IconBtn, {
    icon: theme === 'dark' ? 'sunny-outline' : 'moon-outline',
    onClick: onToggleTheme,
    size: 34,
    iconSize: 17,
    border: true
  }), /*#__PURE__*/React.createElement(StreakChip, {
    days: PERSON.streak,
    freezes: PERSON.freezes,
    onClick: onOpenStreak
  }))), /*#__PURE__*/React.createElement("h1", {
    style: {
      margin: '10px 0 0',
      fontFamily: T.serif,
      fontWeight: 600,
      fontSize: 34,
      lineHeight: 1.05,
      letterSpacing: '-0.02em',
      color: T.ink
    }
  }, "Good evening."), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontSize: 15,
      color: T.ink2,
      marginTop: 7
    }
  }, READY.total, " cards ready \xB7 about ", READY.mins, " min")), heroStyle === 'stack' ? /*#__PURE__*/React.createElement("div", {
    style: {
      margin: '24px 0 0'
    }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: onStartSession,
    style: {
      position: 'relative',
      cursor: 'pointer',
      padding: '10px 0 0'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      left: 18,
      right: 18,
      top: 0,
      height: 40,
      background: T.card,
      border: `1px solid ${T.hair}`,
      borderRadius: 16,
      transform: 'rotate(-1.2deg)',
      opacity: 0.6
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      left: 9,
      right: 9,
      top: 5,
      height: 40,
      background: T.card,
      border: `1px solid ${T.hair}`,
      borderRadius: 16,
      transform: 'rotate(0.7deg)',
      opacity: 0.85
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative',
      background: T.card,
      border: `1px solid ${T.hair}`,
      borderRadius: 18,
      boxShadow: T.shCard,
      padding: '20px 22px 18px',
      textAlign: 'center'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between'
    }
  }, /*#__PURE__*/React.createElement(Overline, {
    style: {
      letterSpacing: '0.11em'
    }
  }, "Up first"), /*#__PURE__*/React.createElement(LevelBadge, {
    level: first.level
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.serif,
      fontWeight: 600,
      fontSize: 36,
      letterSpacing: '-0.015em',
      color: T.ink,
      margin: '18px 0 4px',
      lineHeight: 1.05
    }
  }, first.word), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.mono,
      fontSize: 13,
      color: T.ink3,
      marginBottom: 18,
      whiteSpace: 'nowrap'
    }
  }, first.ipa), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'center',
      gap: 18,
      paddingTop: 14,
      borderTop: `1px solid ${T.hairSoft}`,
      fontFamily: T.sans,
      fontSize: 13,
      color: T.ink2
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      whiteSpace: 'nowrap'
    }
  }, /*#__PURE__*/React.createElement("b", {
    style: {
      color: T.ink,
      fontFeatureSettings: "'tnum' 1"
    }
  }, READY.due), " due"), /*#__PURE__*/React.createElement("span", {
    style: {
      whiteSpace: 'nowrap'
    }
  }, /*#__PURE__*/React.createElement("b", {
    style: {
      color: T.ink,
      fontFeatureSettings: "'tnum' 1"
    }
  }, READY.neww), " new"), /*#__PURE__*/React.createElement("span", {
    style: {
      whiteSpace: 'nowrap'
    }
  }, /*#__PURE__*/React.createElement("b", {
    style: {
      color: T.ink,
      fontFeatureSettings: "'tnum' 1"
    }
  }, READY.learning), " learning")))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 14
    }
  }, /*#__PURE__*/React.createElement(Btn, {
    full: true,
    size: "lg",
    icon: "play",
    onClick: onStartSession,
    style: {
      animation: 'pulseSoft 3.2s ease-in-out infinite'
    }
  }, "Start review"))) :
  /*#__PURE__*/
  /* command-panel variant */
  React.createElement("div", {
    style: {
      margin: '24px 0 0',
      background: T.pine,
      borderRadius: 18,
      padding: '20px 22px 18px',
      boxShadow: T.shMd,
      color: T.inkOn
    }
  }, /*#__PURE__*/React.createElement(Overline, {
    style: {
      color: 'rgba(255,255,255,0.7)'
    }
  }, "Today"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'baseline',
      gap: 8,
      margin: '8px 0 2px'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: T.sans,
      fontWeight: 800,
      fontSize: 46,
      letterSpacing: '-0.03em',
      fontFeatureSettings: "'tnum' 1"
    }
  }, READY.total), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: T.serif,
      fontStyle: 'italic',
      fontSize: 21
    }
  }, "cards ready")), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontSize: 13.5,
      opacity: 0.85,
      marginBottom: 16
    }
  }, READY.due, " due \xB7 ", READY.neww, " new \xB7 ", READY.learning, " learning"), /*#__PURE__*/React.createElement(Btn, {
    kind: "reward",
    full: true,
    size: "lg",
    icon: "play",
    onClick: onStartSession
  }, "Start review \xB7 ~", READY.mins, " min")), /*#__PURE__*/React.createElement(SectionHead, null, "Daily goal"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: 18,
      padding: '10px 0 4px'
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      marginBottom: 7
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: T.sans,
      fontSize: 13,
      fontWeight: 650,
      color: T.ink2
    }
  }, "Reviews"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: T.mono,
      fontSize: 12.5,
      color: T.ink3
    }
  }, PERSON.doneReviews, "/", PERSON.goalReviews)), /*#__PURE__*/React.createElement(Bar, {
    value: PERSON.doneReviews / PERSON.goalReviews * 100,
    color: T.pine
  })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      marginBottom: 7
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: T.sans,
      fontSize: 13,
      fontWeight: 650,
      color: T.ink2
    }
  }, "New cards"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: T.mono,
      fontSize: 12.5,
      color: T.ink3
    }
  }, PERSON.doneNew, "/", PERSON.goalNew)), /*#__PURE__*/React.createElement(Bar, {
    value: PERSON.doneNew / PERSON.goalNew * 100,
    color: T.amber
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '10px 0 0',
      fontFamily: T.sans,
      fontSize: 13,
      color: T.ink2
    }
  }, /*#__PURE__*/React.createElement(Ion, {
    name: "shield-checkmark",
    size: 15,
    color: T.success
  }), /*#__PURE__*/React.createElement("span", null, "Streak safe today \xB7 next reminder ", /*#__PURE__*/React.createElement("b", null, "9:00 PM"))), /*#__PURE__*/React.createElement(SectionHead, {
    actionLabel: "Manage",
    onAction: onManage
  }, "Your decks"), /*#__PURE__*/React.createElement("div", null, DECKS.filter(d => d.active).map((d, i, arr) => /*#__PURE__*/React.createElement(Row, {
    key: d.id,
    onClick: () => onPeekDeck(d),
    last: i === arr.length - 1,
    pad: "15px 0"
  }, /*#__PURE__*/React.createElement(FlagSq, {
    flag: d.flag
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: T.sans,
      fontWeight: 700,
      fontSize: 15.5,
      color: T.ink,
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis'
    }
  }, d.name)), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontSize: 12.5,
      color: T.ink3,
      margin: '2px 0 8px',
      fontFeatureSettings: "'tnum' 1"
    }
  }, d.total.toLocaleString('en-US'), " cards \xB7 ", Math.round(d.mastered / d.total * 100), "% mastered"), /*#__PURE__*/React.createElement(SegBar, {
    mastered: d.mastered,
    learning: d.learning,
    neww: d.neww,
    total: d.total
  })), d.due > 0 ? /*#__PURE__*/React.createElement("button", {
    onClick: e => {
      e.stopPropagation();
      onStudyDeck(d);
    },
    style: {
      flex: 'none',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 1,
      background: T.pineTint,
      border: 'none',
      borderRadius: 12,
      padding: '8px 13px',
      cursor: 'pointer'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: T.sans,
      fontWeight: 800,
      fontSize: 16,
      color: T.pine,
      fontFeatureSettings: "'tnum' 1"
    }
  }, d.due), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: T.sans,
      fontWeight: 700,
      fontSize: 10,
      color: T.pine,
      textTransform: 'uppercase',
      letterSpacing: '0.05em'
    }
  }, "due")) : /*#__PURE__*/React.createElement(Ion, {
    name: "checkmark-circle",
    size: 20,
    color: T.success,
    style: {
      opacity: 0.7
    }
  })))), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontSize: 12.5,
      color: T.ink3,
      padding: '12px 0 0',
      display: 'flex',
      alignItems: 'center',
      gap: 6
    }
  }, /*#__PURE__*/React.createElement(Ion, {
    name: "information-circle-outline",
    size: 14
  }), "2 decks paused \u2014 find them under Study."));
}

/* streak sheet — visible, explained, earnable freezes (C2) */
function StreakSheet({
  open,
  onClose
}) {
  const dot = (d, i) => {
    const map = {
      s: {
        bg: T.amber,
        icon: null
      },
      f: {
        bg: T.infoTint,
        icon: 'snow'
      },
      m: {
        bg: T.paperSunk,
        icon: null
      },
      t: {
        bg: T.pine,
        icon: null
      }
    }[d];
    return /*#__PURE__*/React.createElement("div", {
      key: i,
      style: {
        width: 22,
        height: 22,
        borderRadius: 999,
        background: map.bg,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: d === 't' ? `2px solid ${T.pineDeep}` : 'none',
        boxSizing: 'border-box'
      }
    }, map.icon && /*#__PURE__*/React.createElement(Ion, {
      name: map.icon,
      size: 12,
      color: T.info
    }));
  };
  return /*#__PURE__*/React.createElement(Sheet, {
    open: open,
    onClose: onClose,
    title: "Your streak"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'baseline',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: T.sans,
      fontWeight: 800,
      fontSize: 44,
      color: T.ink,
      letterSpacing: '-0.03em',
      fontFeatureSettings: "'tnum' 1"
    }
  }, PERSON.streak), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: T.serif,
      fontStyle: 'italic',
      fontSize: 19,
      color: T.ink2
    }
  }, "days in a row")), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontSize: 13.5,
      color: T.ink3,
      margin: '2px 0 16px'
    }
  }, "Best: ", PERSON.best, " days"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 7,
      marginBottom: 8
    }
  }, DAYS14.map(dot)), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontSize: 12.5,
      color: T.ink3,
      marginBottom: 18
    }
  }, "Last 14 days \xB7 blue = saved by a freeze"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      background: T.infoTint,
      borderRadius: 14,
      padding: '13px 15px'
    }
  }, /*#__PURE__*/React.createElement(Ion, {
    name: "snow",
    size: 20,
    color: T.info
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontWeight: 700,
      fontSize: 14,
      color: T.ink
    }
  }, PERSON.freezes, " streak freezes"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontSize: 12.5,
      color: T.ink2
    }
  }, "A freeze bridges one missed day. Earn one at every 7-day milestone."))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      marginTop: 12,
      padding: '11px 15px',
      background: T.successTint,
      borderRadius: 14,
      fontFamily: T.sans,
      fontSize: 13,
      color: T.ink
    }
  }, /*#__PURE__*/React.createElement(Ion, {
    name: "shield-checkmark",
    size: 18,
    color: T.success
  }), /*#__PURE__*/React.createElement("span", null, "Last week your 12-day streak was saved \u2014 1 freeze used.")));
}
Object.assign(window, {
  HomeScreen,
  StreakSheet
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/app-v2/screen-home.jsx", error: String((e && e.message) || e) }); }

// ui_kits/app-v2/screen-import.jsx
try { (() => {
/* Import hub (B6) — one destination, three sources (file / AnkiWeb / backup),
   a shared staged flow with an honest preview, cancellable progress, and a
   "Go study" forward action at the end. AnkiWeb search lives in-app (B6b). */

function ImportScreen({
  onBack,
  onSnack,
  onStudy
}) {
  const {
    useState,
    useEffect
  } = React;
  const [src, setSrc] = useState('anki');
  const [stage, setStage] = useState('idle'); // idle | preview | importing | done
  const [prog, setProg] = useState(0);
  const [q, setQ] = useState('');
  const results = [{
    name: 'German Top 4000 Vocabulary',
    cards: 4044,
    cat: 'German',
    by: 'AnkiWeb'
  }, {
    name: 'Goethe-Institut A1 Wortliste',
    cards: 650,
    cat: 'German',
    by: 'AnkiWeb'
  }, {
    name: 'German Sentences — B1/B2',
    cards: 2980,
    cat: 'German',
    by: 'AnkiWeb'
  }].filter(r => !q || r.name.toLowerCase().includes(q.toLowerCase()));

  /* pasted AnkiWeb URL or numeric deck ID → straight to preview (B6b) */
  const pastedId = /^(https?:\/\/|ankiweb\.|\d{6,})/i.test(q.trim());
  useEffect(() => {
    if (stage !== 'importing') return;
    setProg(0);
    const t = setInterval(() => setProg(p => {
      if (p >= 100) {
        clearInterval(t);
        setStage('done');
        return 100;
      }
      return p + 4;
    }), 60);
    return () => clearInterval(t);
  }, [stage]);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      inset: 0,
      background: T.paper,
      zIndex: 55
    }
  }, /*#__PURE__*/React.createElement(StackBar, {
    title: "Import",
    sub: "Bring your own vocabulary",
    backIcon: "close",
    onBack: onBack
  }), /*#__PURE__*/React.createElement("div", {
    className: "mk-scroll",
    style: {
      position: 'absolute',
      top: TOPPAD + 52,
      bottom: 0,
      left: 0,
      right: 0,
      overflowY: 'auto',
      padding: '16px 20px 40px'
    }
  }, stage === 'idle' && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(SegCtrl, {
    value: src,
    onChange: setSrc,
    options: [{
      id: 'anki',
      label: 'AnkiWeb'
    }, {
      id: 'file',
      label: 'From a file'
    }, {
      id: 'backup',
      label: 'Backup'
    }]
  }), src === 'anki' && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 18
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 9,
      background: T.card,
      border: `1px solid ${T.hairStrong}`,
      borderRadius: 999,
      padding: '11px 16px'
    }
  }, /*#__PURE__*/React.createElement(Ion, {
    name: "search",
    size: 16,
    color: T.ink3
  }), /*#__PURE__*/React.createElement("input", {
    value: q,
    onChange: e => setQ(e.target.value),
    placeholder: "Search shared decks\u2026",
    style: {
      flex: 1,
      border: 'none',
      background: 'none',
      fontFamily: T.sans,
      fontSize: 14.5,
      color: T.ink
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontSize: 12.5,
      color: T.ink3,
      margin: '10px 2px 4px'
    }
  }, pastedId ? 'From your link' : 'Popular for German learners'), pastedId && /*#__PURE__*/React.createElement(Row, {
    onClick: () => setStage('preview'),
    pad: "13px 0",
    last: results.length === 0
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 36,
      height: 36,
      borderRadius: 10,
      background: T.pineTint,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flex: 'none'
    }
  }, /*#__PURE__*/React.createElement(Ion, {
    name: "link-outline",
    size: 17,
    color: T.pine
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontWeight: 700,
      fontSize: 14.5,
      color: T.ink
    }
  }, "Import from AnkiWeb"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.mono,
      fontSize: 12,
      color: T.ink3,
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis'
    }
  }, q.trim())), /*#__PURE__*/React.createElement(Ion, {
    name: "chevron-forward",
    size: 16,
    color: T.ink3
  })), results.map((r, i) => /*#__PURE__*/React.createElement(Row, {
    key: r.name,
    onClick: () => setStage('preview'),
    pad: "13px 0",
    last: i === results.length - 1
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 36,
      height: 36,
      borderRadius: 10,
      background: T.infoTint,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flex: 'none'
    }
  }, /*#__PURE__*/React.createElement(Ion, {
    name: "albums-outline",
    size: 17,
    color: T.info
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontWeight: 700,
      fontSize: 14.5,
      color: T.ink,
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis'
    }
  }, r.name), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontSize: 12.5,
      color: T.ink3,
      fontFeatureSettings: "'tnum' 1"
    }
  }, r.cards.toLocaleString('en-US'), " cards \xB7 ", r.cat)), /*#__PURE__*/React.createElement(Ion, {
    name: "chevron-forward",
    size: 16,
    color: T.ink3
  }))), results.length === 0 && !pastedId && /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: 'center',
      padding: '26px 16px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.serif,
      fontSize: 17,
      color: T.ink,
      marginBottom: 4
    }
  }, "No shared decks match"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontSize: 13,
      color: T.ink3
    }
  }, "Try another search \u2014 or paste an AnkiWeb URL / deck ID.")), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontSize: 12.5,
      color: T.ink3,
      marginTop: 14,
      textAlign: 'center'
    }
  }, "or paste an AnkiWeb URL / deck ID above")), src === 'file' && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 18
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setStage('preview'),
    style: {
      width: '100%',
      border: `1.5px dashed ${T.hairStrong}`,
      borderRadius: 16,
      background: 'transparent',
      padding: '34px 20px',
      cursor: 'pointer',
      textAlign: 'center'
    }
  }, /*#__PURE__*/React.createElement(Ion, {
    name: "document-attach-outline",
    size: 30,
    color: T.ink3
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontWeight: 700,
      fontSize: 15,
      color: T.ink,
      margin: '10px 0 4px'
    }
  }, "Choose a file"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontSize: 13,
      color: T.ink3
    }
  }, ".csv or .apkg \u2014 we\u2019ll detect which")), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontSize: 12.5,
      color: T.ink3,
      marginTop: 12,
      lineHeight: 1.5
    }
  }, "CSV columns map to Word, Translation, Example, Level, Type, Pronunciation and Tags \u2014 you\u2019ll confirm the mapping before anything is written.")), src === 'backup' && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 18
    }
  }, /*#__PURE__*/React.createElement(ListRow, {
    icon: "refresh-circle-outline",
    title: "Restore a Maranki backup",
    sub: "A .json file from Settings \u2192 Export",
    last: true,
    onClick: () => onSnack('Choose a backup file')
  }))), stage === 'preview' && /*#__PURE__*/React.createElement("div", {
    style: {
      animation: 'riseIn .25s cubic-bezier(0.22,1,0.36,1)'
    }
  }, /*#__PURE__*/React.createElement(Overline, {
    style: {
      marginBottom: 10
    }
  }, "Preview \u2014 nothing imported yet"), /*#__PURE__*/React.createElement(Card, null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.serif,
      fontWeight: 600,
      fontSize: 20,
      color: T.ink,
      marginBottom: 12
    }
  }, "German Top 4000 Vocabulary"), [['Cards', '4,044'], ['With study progress', '1,212'], ['Audio & images', '388 files'], ['Already in your library', '36 duplicates — will be skipped']].map(([l, n], i, arr) => /*#__PURE__*/React.createElement("div", {
    key: l,
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      padding: '8px 0',
      borderBottom: i < arr.length - 1 ? `1px solid ${T.hairSoft}` : 'none'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: T.sans,
      fontSize: 13.5,
      color: T.ink2
    }
  }, l), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: T.mono,
      fontSize: 12.5,
      color: T.ink,
      fontFeatureSettings: "'tnum' 1"
    }
  }, n)))), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontSize: 12.5,
      color: T.ink3,
      margin: '12px 2px'
    }
  }, "Anki scheduling is preserved \u2014 ease, intervals and due dates come along."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 10,
      marginTop: 8
    }
  }, /*#__PURE__*/React.createElement(Btn, {
    kind: "secondary",
    full: true,
    onClick: () => setStage('idle')
  }, "Cancel"), /*#__PURE__*/React.createElement(Btn, {
    full: true,
    icon: "cloud-download-outline",
    onClick: () => setStage('importing')
  }, "Import deck"))), stage === 'importing' && /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: 'center',
      padding: '40px 10px'
    }
  }, /*#__PURE__*/React.createElement(Ring, {
    value: prog,
    size: 86,
    stroke: 6
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: T.sans,
      fontWeight: 800,
      fontSize: 19,
      color: T.ink,
      fontFeatureSettings: "'tnum' 1"
    }
  }, prog, "%")), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontWeight: 700,
      fontSize: 15.5,
      color: T.ink,
      margin: '18px 0 4px'
    }
  }, "Importing 4,044 cards\u2026"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontSize: 13,
      color: T.ink3,
      marginBottom: 22
    }
  }, "Keeping your Anki scheduling intact."), /*#__PURE__*/React.createElement(Btn, {
    kind: "quiet",
    onClick: () => {
      setStage('idle');
      onSnack('Import cancelled — nothing was written');
    }
  }, "Cancel")), stage === 'done' && /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: 'center',
      padding: '36px 10px',
      animation: 'riseIn .3s cubic-bezier(0.22,1,0.36,1)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 60,
      height: 60,
      borderRadius: 999,
      background: T.pineTint,
      margin: '0 auto 16px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }
  }, /*#__PURE__*/React.createElement(Ion, {
    name: "checkmark",
    size: 30,
    color: T.pine
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.serif,
      fontWeight: 600,
      fontSize: 23,
      color: T.ink,
      marginBottom: 6
    }
  }, "4,008 cards imported"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontSize: 13.5,
      color: T.ink3,
      marginBottom: 24
    }
  }, "36 duplicates skipped \xB7 142 ready to study now"), /*#__PURE__*/React.createElement(Btn, {
    full: true,
    size: "lg",
    icon: "play",
    onClick: onStudy
  }, "Study the new deck"), /*#__PURE__*/React.createElement("button", {
    onClick: onBack,
    style: {
      display: 'block',
      margin: '16px auto 0',
      background: 'none',
      border: 'none',
      cursor: 'pointer',
      fontFamily: T.sans,
      fontWeight: 700,
      fontSize: 14,
      color: T.ink2
    }
  }, "Done"))));
}
Object.assign(window, {
  ImportScreen
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/app-v2/screen-import.jsx", error: String((e && e.message) || e) }); }

// ui_kits/app-v2/screen-launchpad.jsx
try { (() => {
/* Study — the launchpad (B1). One place to *do*: an aggregate "study now"
   command, then every studiable object — decks and collections — as a row
   with an honest due count and a one-tap study action. Paused decks sit in
   a disclosure. The universal peek sheet (Study / Browse cards / Edit)
   replaces hidden long-presses; the FAB opens the global create menu (B2). */

function LaunchpadScreen({
  onStartSession,
  onPeek,
  onStudy,
  onCreate,
  onImport,
  onSnack
}) {
  const {
    useState
  } = React;
  const [showPaused, setShowPaused] = useState(false);
  const active = DECKS.filter(d => d.active);
  const paused = DECKS.filter(d => !d.active);
  return /*#__PURE__*/React.createElement(Page, null, /*#__PURE__*/React.createElement(ScreenHead, {
    title: "Study",
    sub: "Pick what to review \u2014 or just start.",
    right: /*#__PURE__*/React.createElement(IconBtn, {
      icon: "cloud-download-outline",
      size: 36,
      iconSize: 18,
      border: true,
      onClick: onImport
    })
  }), /*#__PURE__*/React.createElement(Card, {
    onClick: onStartSession,
    style: {
      marginTop: 14,
      display: 'flex',
      alignItems: 'center',
      gap: 14,
      padding: '16px 18px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 46,
      height: 46,
      borderRadius: 999,
      background: T.pine,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flex: 'none',
      boxShadow: T.shSm
    }
  }, /*#__PURE__*/React.createElement(Ion, {
    name: "play",
    size: 20,
    color: "#fff"
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontWeight: 750,
      fontSize: 16,
      color: T.ink
    }
  }, "Study now"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontSize: 13,
      color: T.ink2,
      fontFeatureSettings: "'tnum' 1"
    }
  }, READY.total, " ready across ", active.length, " decks \xB7 ~", READY.mins, " min")), /*#__PURE__*/React.createElement(Ion, {
    name: "chevron-forward",
    size: 17,
    color: T.ink3
  })), /*#__PURE__*/React.createElement(SectionHead, null, "Decks"), /*#__PURE__*/React.createElement("div", null, active.map((d, i) => /*#__PURE__*/React.createElement(Row, {
    key: d.id,
    onClick: () => onPeek(d),
    pad: "14px 0",
    last: i === active.length - 1 && !paused.length
  }, /*#__PURE__*/React.createElement(FlagSq, {
    flag: d.flag,
    size: 36
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 7
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: T.sans,
      fontWeight: 700,
      fontSize: 15,
      color: T.ink,
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis'
    }
  }, d.name), !d.builtin && /*#__PURE__*/React.createElement(Pill, {
    fg: T.info,
    bg: T.infoTint
  }, "imported")), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontSize: 12.5,
      color: T.ink3,
      marginTop: 2,
      fontFeatureSettings: "'tnum' 1"
    }
  }, d.total.toLocaleString('en-US'), " cards", d.due > 0 ? ` · ${d.due} due` : ' · caught up')), d.due > 0 ? /*#__PURE__*/React.createElement(Btn, {
    size: "sm",
    onClick: e => {
      e.stopPropagation();
      onStudy(d);
    }
  }, "Study ", d.due) : /*#__PURE__*/React.createElement(Ion, {
    name: "checkmark-circle",
    size: 19,
    color: T.success,
    style: {
      opacity: 0.65
    }
  }))), paused.length > 0 && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("button", {
    onClick: () => setShowPaused(!showPaused),
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      background: 'none',
      border: 'none',
      cursor: 'pointer',
      padding: '13px 0',
      fontFamily: T.sans,
      fontWeight: 650,
      fontSize: 13.5,
      color: T.ink3,
      width: '100%'
    }
  }, /*#__PURE__*/React.createElement(Ion, {
    name: showPaused ? 'chevron-down' : 'chevron-forward',
    size: 14
  }), "Paused (", paused.length, ")"), showPaused && paused.map((d, i) => /*#__PURE__*/React.createElement(Row, {
    key: d.id,
    onClick: () => onPeek(d),
    pad: "12px 0",
    last: i === paused.length - 1,
    style: {
      opacity: 0.75
    }
  }, /*#__PURE__*/React.createElement(FlagSq, {
    flag: d.flag,
    size: 34
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontWeight: 650,
      fontSize: 14.5,
      color: T.ink2
    }
  }, d.name), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontSize: 12,
      color: T.ink3,
      fontFeatureSettings: "'tnum' 1"
    }
  }, d.total.toLocaleString('en-US'), " cards")), /*#__PURE__*/React.createElement(Btn, {
    size: "sm",
    kind: "secondary",
    onClick: e => {
      e.stopPropagation();
      onSnack(`${d.name} resumed — its cards rejoin your queue`);
    }
  }, "Resume"))))), /*#__PURE__*/React.createElement(SectionHead, {
    actionLabel: "+ New",
    onAction: onCreate
  }, "Collections"), /*#__PURE__*/React.createElement("div", null, COLLECTIONS.map((c, i) => /*#__PURE__*/React.createElement(Row, {
    key: c.id,
    onClick: () => onPeek({
      ...c,
      isCollection: true
    }),
    pad: "13px 0",
    last: i === COLLECTIONS.length - 1
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 36,
      height: 36,
      borderRadius: 10,
      background: T.pineTint,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flex: 'none'
    }
  }, /*#__PURE__*/React.createElement(Ion, {
    name: c.icon,
    size: 17,
    color: T.pine
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontWeight: 700,
      fontSize: 15,
      color: T.ink
    }
  }, c.name), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontSize: 12.5,
      color: T.ink3,
      marginTop: 1,
      fontFeatureSettings: "'tnum' 1"
    }
  }, c.count, " cards \xB7 ", c.due, " due")), c.due > 0 ? /*#__PURE__*/React.createElement(Btn, {
    size: "sm",
    kind: "secondary",
    onClick: e => {
      e.stopPropagation();
      onStudy(c);
    }
  }, "Study ", c.due) : /*#__PURE__*/React.createElement(Ion, {
    name: "checkmark-circle",
    size: 19,
    color: T.success,
    style: {
      opacity: 0.65
    }
  })))), /*#__PURE__*/React.createElement(FAB, {
    onClick: onCreate
  }));
}

/* ——— universal object peek (B1): tap any deck/collection anywhere ——— */
function PeekSheet({
  obj,
  onClose,
  onStudy,
  onBrowse,
  onEdit
}) {
  if (!obj) return null;
  const isColl = obj.isCollection;
  return /*#__PURE__*/React.createElement(Sheet, {
    open: !!obj,
    onClose: onClose
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 13,
      marginBottom: 4
    }
  }, isColl ? /*#__PURE__*/React.createElement("div", {
    style: {
      width: 44,
      height: 44,
      borderRadius: 12,
      background: T.pineTint,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }
  }, /*#__PURE__*/React.createElement(Ion, {
    name: obj.icon,
    size: 20,
    color: T.pine
  })) : /*#__PURE__*/React.createElement(FlagSq, {
    flag: obj.flag,
    size: 44
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.serif,
      fontWeight: 600,
      fontSize: 21,
      color: T.ink,
      lineHeight: 1.15
    }
  }, obj.name), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontSize: 13,
      color: T.ink3,
      marginTop: 2,
      fontFeatureSettings: "'tnum' 1"
    }
  }, (obj.total || obj.count).toLocaleString('en-US'), " cards", obj.due > 0 ? ` · ${obj.due} due now` : ' · caught up'))), !isColl && /*#__PURE__*/React.createElement("div", {
    style: {
      margin: '14px 0 4px'
    }
  }, /*#__PURE__*/React.createElement(SegBar, {
    mastered: obj.mastered,
    learning: obj.learning,
    neww: obj.neww,
    total: obj.total,
    h: 5
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 14,
      marginTop: 8,
      fontFamily: T.sans,
      fontSize: 12,
      color: T.ink3
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 7,
      height: 7,
      borderRadius: 99,
      background: T.pine
    }
  }), "Mastered ", obj.mastered), /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 7,
      height: 7,
      borderRadius: 99,
      background: T.amber
    }
  }), "Learning ", obj.learning), /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 7,
      height: 7,
      borderRadius: 99,
      background: T.info,
      opacity: 0.6
    }
  }), "New ", obj.neww))), isColl && /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.serif,
      fontStyle: 'italic',
      fontSize: 14.5,
      color: T.ink2,
      margin: '6px 0 2px'
    }
  }, obj.desc), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      marginTop: 18
    }
  }, /*#__PURE__*/React.createElement(Btn, {
    full: true,
    size: "lg",
    icon: "play",
    onClick: onStudy,
    disabled: !obj.due
  }, obj.due > 0 ? `Study ${obj.due} due` : 'Nothing due — study ahead'), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement(Btn, {
    kind: "secondary",
    full: true,
    icon: "search",
    onClick: onBrowse
  }, "Browse cards"), /*#__PURE__*/React.createElement(Btn, {
    kind: "secondary",
    full: true,
    icon: "pencil",
    onClick: onEdit
  }, "Edit"))));
}

/* ——— global create menu (B2) ——— */
function CreateSheet({
  open,
  onClose,
  onNewCard,
  onNewDeck,
  onNewCollection,
  onImport
}) {
  return /*#__PURE__*/React.createElement(Sheet, {
    open: open,
    onClose: onClose,
    title: "Create"
  }, /*#__PURE__*/React.createElement(ListRow, {
    icon: "document-text-outline",
    title: "New card",
    sub: "Add a word to any deck",
    onClick: onNewCard
  }), /*#__PURE__*/React.createElement(ListRow, {
    icon: "albums-outline",
    title: "New deck",
    sub: "A fresh collection of cards",
    onClick: onNewDeck
  }), /*#__PURE__*/React.createElement(ListRow, {
    icon: "funnel-outline",
    title: "New collection",
    sub: "A saved smart filter \u2014 always up to date",
    onClick: onNewCollection
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 1,
      background: T.hairStrong,
      margin: '6px 0'
    }
  }), /*#__PURE__*/React.createElement(ListRow, {
    icon: "cloud-download-outline",
    iconColor: T.info,
    iconBg: T.infoTint,
    title: "Import",
    sub: "CSV \xB7 Anki file \xB7 AnkiWeb",
    onClick: onImport,
    last: true
  }));
}
Object.assign(window, {
  LaunchpadScreen,
  PeekSheet,
  CreateSheet
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/app-v2/screen-launchpad.jsx", error: String((e && e.message) || e) }); }

// ui_kits/app-v2/screen-onboarding.jsx
try { (() => {
/* Onboarding — language first (F1). Four data-driven steps, a persistent
   skip, and an exit that lands the learner in a state matching their choice. */

function OnboardingScreen({
  onDone,
  onStartSession,
  onImport
}) {
  const {
    useState
  } = React;
  const [step, setStep] = useState(0);
  const [lang, setLang] = useState(null);
  const [neww, setNeww] = useState(10);
  const [reviews, setReviews] = useState(30);
  const mins = Math.max(2, Math.round((neww + reviews) * 10 / 60));
  const next = () => step < 3 ? setStep(step + 1) : onDone();
  const steps = [
  /*#__PURE__*/
  /* 0 — welcome */
  React.createElement("div", {
    key: "w",
    style: {
      textAlign: 'center',
      animation: 'riseIn .3s cubic-bezier(0.22,1,0.36,1)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.serif,
      fontWeight: 600,
      fontSize: 44,
      letterSpacing: '-0.02em',
      color: T.ink,
      marginTop: 30
    }
  }, "Maranki"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.serif,
      fontStyle: 'italic',
      fontSize: 19,
      color: T.ink2,
      margin: '10px 0 30px'
    }
  }, "Learn words. Keep them."), /*#__PURE__*/React.createElement(Card, {
    style: {
      textAlign: 'left'
    }
  }, [['albums-outline', 'Study a few cards a day', 'Short sessions, real sentences.'], ['repeat', 'We bring each word back', 'Just before you’d forget it — that’s spaced repetition.'], ['flame', 'Streaks make it stick', 'A little every day beats a lot once a week.']].map(([ic, t, s], i, arr) => /*#__PURE__*/React.createElement("div", {
    key: t,
    style: {
      display: 'flex',
      gap: 13,
      alignItems: 'flex-start',
      padding: '11px 0',
      borderBottom: i < arr.length - 1 ? `1px solid ${T.hairSoft}` : 'none'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 36,
      height: 36,
      borderRadius: 11,
      background: T.pineTint,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flex: 'none'
    }
  }, /*#__PURE__*/React.createElement(Ion, {
    name: ic,
    size: 17,
    color: T.pine
  })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontWeight: 700,
      fontSize: 14.5,
      color: T.ink
    }
  }, t), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontSize: 13,
      color: T.ink3,
      marginTop: 1
    }
  }, s)))))),
  /*#__PURE__*/
  /* 1 — language first */
  React.createElement("div", {
    key: "l",
    style: {
      animation: 'riseIn .3s cubic-bezier(0.22,1,0.36,1)'
    }
  }, /*#__PURE__*/React.createElement("h2", {
    style: {
      fontFamily: T.serif,
      fontWeight: 600,
      fontSize: 26,
      color: T.ink,
      margin: '24px 0 6px',
      lineHeight: 1.15
    }
  }, "What do you want to learn?"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontSize: 14,
      color: T.ink2,
      marginBottom: 20
    }
  }, "We\u2019ll set up the right decks for you."), [['🇩🇪', 'German', '560 cards · A1–B1'], ['🇪🇸', 'Spanish', '180 cards · B1'], ['🇫🇷', 'French', '150 cards · A1']].map(([f, l, s]) => /*#__PURE__*/React.createElement("button", {
    key: l,
    onClick: () => setLang(l),
    style: {
      width: '100%',
      display: 'flex',
      alignItems: 'center',
      gap: 13,
      padding: '13px 15px',
      marginBottom: 10,
      background: lang === l ? T.pineTint : T.card,
      borderRadius: 14,
      cursor: 'pointer',
      boxSizing: 'border-box',
      border: lang === l ? `1.5px solid ${T.pine}` : `1px solid ${T.hair}`
    }
  }, /*#__PURE__*/React.createElement(FlagSq, {
    flag: f,
    size: 40
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      textAlign: 'left'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontWeight: 750,
      fontSize: 16,
      color: T.ink
    }
  }, l), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontSize: 12.5,
      color: T.ink3
    }
  }, s)), lang === l && /*#__PURE__*/React.createElement(Ion, {
    name: "checkmark-circle",
    size: 22,
    color: T.pine
  }))), /*#__PURE__*/React.createElement("button", {
    onClick: onImport,
    style: {
      width: '100%',
      background: 'none',
      border: `1.5px dashed ${T.hairStrong}`,
      borderRadius: 14,
      padding: '13px 15px',
      cursor: 'pointer',
      fontFamily: T.sans,
      fontWeight: 650,
      fontSize: 14,
      color: T.ink2,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement(Ion, {
    name: "cloud-download-outline",
    size: 17
  }), "Or import your own deck")),
  /*#__PURE__*/
  /* 2 — goals */
  React.createElement("div", {
    key: "g",
    style: {
      animation: 'riseIn .3s cubic-bezier(0.22,1,0.36,1)'
    }
  }, /*#__PURE__*/React.createElement("h2", {
    style: {
      fontFamily: T.serif,
      fontWeight: 600,
      fontSize: 28,
      color: T.ink,
      margin: '24px 0 4px'
    }
  }, "A pace you can keep"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontSize: 14,
      color: T.ink2,
      marginBottom: 18
    }
  }, "You can change this anytime in Settings."), /*#__PURE__*/React.createElement(Card, null, /*#__PURE__*/React.createElement(Row, {
    pad: "12px 0"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontWeight: 700,
      fontSize: 14.5,
      color: T.ink
    }
  }, "New words a day"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontSize: 12.5,
      color: T.ink3
    }
  }, "Fresh vocabulary entering rotation")), /*#__PURE__*/React.createElement(Stepper, {
    value: neww,
    onChange: setNeww,
    min: 5,
    max: 50,
    step: 5
  })), /*#__PURE__*/React.createElement(Row, {
    pad: "12px 0",
    last: true
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontWeight: 700,
      fontSize: 14.5,
      color: T.ink
    }
  }, "Reviews a day"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontSize: 12.5,
      color: T.ink3
    }
  }, "Words coming back to be kept")), /*#__PURE__*/React.createElement(Stepper, {
    value: reviews,
    onChange: setReviews,
    min: 10,
    max: 200,
    step: 10
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      marginTop: 16,
      fontFamily: T.sans,
      fontSize: 13.5,
      color: T.ink2
    }
  }, /*#__PURE__*/React.createElement(Ion, {
    name: "time-outline",
    size: 15,
    color: T.pine
  }), "That\u2019s about ", /*#__PURE__*/React.createElement("b", {
    style: {
      color: T.ink
    }
  }, mins, " minutes"), " a day.")),
  /*#__PURE__*/
  /* 3 — ready */
  React.createElement("div", {
    key: "r",
    style: {
      textAlign: 'center',
      animation: 'riseIn .3s cubic-bezier(0.22,1,0.36,1)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 64,
      height: 64,
      borderRadius: 999,
      background: T.amberTint,
      margin: '36px auto 18px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }
  }, /*#__PURE__*/React.createElement(Ion, {
    name: "flame",
    size: 30,
    color: T.amber
  })), /*#__PURE__*/React.createElement("h2", {
    style: {
      fontFamily: T.serif,
      fontWeight: 600,
      fontSize: 28,
      color: T.ink,
      margin: '0 0 8px'
    }
  }, lang || 'German', ", ", neww, " new words a day."), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontSize: 14.5,
      color: T.ink2,
      lineHeight: 1.5,
      maxWidth: 270,
      margin: '0 auto'
    }
  }, "Your first session is ready \u2014 ", neww, " words, about ", Math.max(2, Math.round(neww * 10 / 60)), " minutes. Day one of your streak starts now."))];
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      inset: 0,
      background: T.paper,
      zIndex: 80,
      display: 'flex',
      flexDirection: 'column'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: `${TOPPAD}px 20px 0`
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 6
    }
  }, [0, 1, 2, 3].map(i => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      width: i === step ? 22 : 7,
      height: 7,
      borderRadius: 99,
      transition: 'all .25s',
      background: i <= step ? T.pine : T.hairStrong
    }
  }))), /*#__PURE__*/React.createElement("button", {
    onClick: onDone,
    style: {
      background: 'none',
      border: 'none',
      cursor: 'pointer',
      fontFamily: T.sans,
      fontWeight: 700,
      fontSize: 14,
      color: T.ink3
    }
  }, "Skip")), /*#__PURE__*/React.createElement("div", {
    className: "mk-scroll",
    style: {
      flex: 1,
      overflowY: 'auto',
      padding: '0 22px'
    }
  }, steps[step]), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '14px 22px 30px'
    }
  }, step === 3 ? /*#__PURE__*/React.createElement(Btn, {
    full: true,
    size: "lg",
    icon: "play",
    onClick: onStartSession
  }, "Start learning") : /*#__PURE__*/React.createElement(Btn, {
    full: true,
    size: "lg",
    onClick: next,
    disabled: step === 1 && !lang
  }, "Continue")));
}
Object.assign(window, {
  OnboardingScreen
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/app-v2/screen-onboarding.jsx", error: String((e && e.message) || e) }); }

// ui_kits/app-v2/screen-session.jsx
try { (() => {
/* Study session — the sacred loop.
   Chrome-minimal: thin ink progress line, the card centered with the rest of
   the queue visible as a stack beneath it. Tap to flip (3D), rate on the
   4-button scale with predicted intervals, undo every rating (A1), "Again"
   visibly requeues within the session, streak milestones celebrate quietly.
   Exiting with progress confirms and records a partial session. */

function RatingBtn({
  label,
  interval,
  color,
  onClick
}) {
  return /*#__PURE__*/React.createElement("button", {
    onClick: onClick,
    style: {
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 3,
      background: softTint(color, 11),
      border: `1px solid ${softTint(color, 28)}`,
      borderRadius: 14,
      padding: '12px 4px 10px',
      cursor: 'pointer',
      transition: 'transform .12s'
    },
    onMouseDown: e => e.currentTarget.style.transform = 'scale(0.96)',
    onMouseUp: e => e.currentTarget.style.transform = 'scale(1)',
    onMouseLeave: e => e.currentTarget.style.transform = 'scale(1)'
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: T.sans,
      fontWeight: 750,
      fontSize: 14.5,
      color
    }
  }, label), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: T.mono,
      fontSize: 11.5,
      color: T.ink3
    }
  }, interval));
}
function SessionScreen({
  deckName = 'German — Everyday',
  onComplete,
  onExit
}) {
  const {
    useState
  } = React;
  const [queue, setQueue] = useState(QUEUE);
  const [idx, setIdx] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [history, setHistory] = useState([]); // [{queue, idx, counts, run}]
  const [counts, setCounts] = useState({
    again: 0,
    hard: 0,
    good: 0,
    easy: 0
  });
  const [run, setRun] = useState(4); // correct-in-a-row (seeded mid-session feel)
  const [snack, setSnack] = useState(null);
  const [milestone, setMilestone] = useState(null);
  const [confirmExit, setConfirmExit] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const card = queue[idx];
  const total = queue.length;
  const reviewed = idx;
  const rate = r => {
    const snapshot = {
      queue,
      idx,
      counts,
      run
    };
    const nextCounts = {
      ...counts,
      [r]: counts[r] + 1
    };
    let nextQueue = queue;
    if (r === 'again') {
      // requeue this card a few positions later, same session
      nextQueue = [...queue];
      const reinsert = Math.min(idx + 3, nextQueue.length);
      nextQueue.splice(reinsert, 0, {
        ...card,
        requeued: true
      });
    }
    const nextRun = r === 'again' ? 0 : run + 1;
    if (nextRun > 0 && nextRun % 5 === 0) {
      setMilestone(nextRun);
      setTimeout(() => setMilestone(null), 1600);
    }
    const labels = {
      again: 'Again',
      hard: 'Hard',
      good: 'Good',
      easy: 'Easy'
    };
    setSnack({
      text: r === 'again' ? `${card.base} is coming back soon in this session` : `Rated ${labels[r]} · next in ${card.pred[r]}`,
      undo: true
    });
    setHistory([...history, snapshot]);
    setCounts(nextCounts);
    setRun(nextRun);
    setRevealed(false);
    if (idx + 1 >= nextQueue.length) {
      onComplete({
        counts: nextCounts,
        total: idx + 1,
        bestRun: Math.max(nextRun, 5)
      });
    } else {
      setQueue(nextQueue);
      setIdx(idx + 1);
    }
  };
  const undo = () => {
    if (!history.length) return;
    const prev = history[history.length - 1];
    setHistory(history.slice(0, -1));
    setQueue(prev.queue);
    setIdx(prev.idx);
    setCounts(prev.counts);
    setRun(prev.run);
    setRevealed(true);
    setSnack({
      text: 'Rating undone — card restored',
      undo: false
    });
  };
  React.useEffect(() => {
    if (!snack) return;
    const t = setTimeout(() => setSnack(null), 2600);
    return () => clearTimeout(t);
  }, [snack]);
  if (!card) return null;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      inset: 0,
      background: T.paper,
      zIndex: 50,
      display: 'flex',
      flexDirection: 'column'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: `${TOPPAD}px 14px 0`
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 6
    }
  }, /*#__PURE__*/React.createElement(IconBtn, {
    icon: "close",
    size: 36,
    iconSize: 20,
    color: T.ink2,
    onClick: () => reviewed > 0 ? setConfirmExit(true) : onExit()
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      textAlign: 'center'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: T.mono,
      fontSize: 13.5,
      color: T.ink2,
      fontFeatureSettings: "'tnum' 1"
    }
  }, idx + 1, " ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: T.ink3
    }
  }, "/ ", total))), /*#__PURE__*/React.createElement(IconBtn, {
    icon: "arrow-undo",
    size: 36,
    iconSize: 18,
    disabled: !history.length,
    onClick: undo,
    color: T.ink2
  }), /*#__PURE__*/React.createElement(IconBtn, {
    icon: "ellipsis-horizontal",
    size: 36,
    iconSize: 18,
    onClick: () => setMoreOpen(true),
    color: T.ink2
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      margin: '8px 2px 0'
    }
  }, /*#__PURE__*/React.createElement(Bar, {
    value: idx / total * 100,
    h: 3
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
      padding: '12px 22px',
      position: 'relative'
    }
  }, milestone && /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: 6,
      left: 0,
      right: 0,
      display: 'flex',
      justifyContent: 'center',
      zIndex: 5
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      background: T.amberTint,
      color: T.amberDeep,
      fontFamily: T.sans,
      fontWeight: 800,
      fontSize: 13.5,
      padding: '7px 14px',
      borderRadius: 999,
      animation: 'popIn .3s cubic-bezier(0.34,1.56,0.64,1)'
    }
  }, /*#__PURE__*/React.createElement(Ion, {
    name: "flame",
    size: 15,
    color: T.amber
  }), milestone, " in a row")), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      left: 14,
      right: 14,
      bottom: -10,
      height: 30,
      background: T.card,
      border: `1px solid ${T.hair}`,
      borderRadius: 18,
      opacity: 0.55
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      left: 7,
      right: 7,
      bottom: -5,
      height: 30,
      background: T.card,
      border: `1px solid ${T.hair}`,
      borderRadius: 18,
      opacity: 0.8
    }
  }), /*#__PURE__*/React.createElement("div", {
    key: card.id + '-' + idx,
    onClick: () => !revealed && setRevealed(true),
    style: {
      position: 'relative',
      background: T.card,
      border: `1px solid ${T.hair}`,
      borderRadius: 20,
      boxShadow: T.shCard,
      minHeight: 330,
      display: 'flex',
      flexDirection: 'column',
      cursor: revealed ? 'default' : 'pointer',
      animation: 'riseIn .28s cubic-bezier(0.22,1,0.36,1)',
      padding: '18px 22px 20px',
      boxSizing: 'border-box'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement(LevelBadge, {
    level: card.level
  }), card.step && /*#__PURE__*/React.createElement(Pill, {
    mono: true,
    fg: T.amberDeep,
    bg: T.amberTint
  }, "step ", card.step), card.requeued && /*#__PURE__*/React.createElement(Pill, {
    fg: T.danger,
    bg: T.dangerTint
  }, "again"), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement(IconBtn, {
    icon: "volume-high-outline",
    size: 34,
    iconSize: 18,
    color: T.pine,
    bg: T.pineTint,
    onClick: e => {
      e.stopPropagation();
      setSnack({
        text: `Playing “${card.base}”`,
        undo: false
      });
    }
  })), !revealed ?
  /*#__PURE__*/
  /* front — the word */
  React.createElement("div", {
    style: {
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      textAlign: 'center'
    }
  }, card.article && /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.serif,
      fontStyle: 'italic',
      fontSize: 21,
      color: T.amberDeep,
      marginBottom: 2
    }
  }, card.article), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.serif,
      fontWeight: 600,
      fontSize: 42,
      letterSpacing: '-0.015em',
      color: T.ink,
      lineHeight: 1.05
    }
  }, card.base), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.mono,
      fontSize: 14,
      color: T.ink3,
      marginTop: 10,
      whiteSpace: 'nowrap'
    }
  }, card.ipa), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 34,
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      fontFamily: T.sans,
      fontSize: 12.5,
      fontWeight: 650,
      color: T.ink3
    }
  }, /*#__PURE__*/React.createElement(Ion, {
    name: "hand-left-outline",
    size: 14
  }), "Tap to reveal")) :
  /*#__PURE__*/
  /* back — the answer */
  React.createElement("div", {
    style: {
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      textAlign: 'center',
      animation: 'fadeIn .22s'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontWeight: 650,
      fontSize: 14.5,
      color: T.ink3
    }
  }, card.word), /*#__PURE__*/React.createElement("div", {
    style: {
      width: 36,
      height: 1,
      background: T.hairStrong,
      margin: '13px 0'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.serif,
      fontWeight: 600,
      fontSize: 31,
      letterSpacing: '-0.015em',
      color: T.ink,
      lineHeight: 1.12
    }
  }, card.tr), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.serif,
      fontStyle: 'italic',
      fontSize: 16.5,
      color: T.ink2,
      marginTop: 18,
      lineHeight: 1.45
    }
  }, card.ex), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontSize: 13,
      color: T.ink3,
      marginTop: 4
    }
  }, card.exTr), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 16
    }
  }, /*#__PURE__*/React.createElement(Pill, null, card.type)))))), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: `0 18px ${26}px`,
      minHeight: 96,
      boxSizing: 'border-box'
    }
  }, revealed ? /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 9,
      animation: 'riseIn .2s cubic-bezier(0.22,1,0.36,1)'
    }
  }, /*#__PURE__*/React.createElement(RatingBtn, {
    label: "Again",
    interval: card.pred.again,
    color: T.rateAgain,
    onClick: () => rate('again')
  }), /*#__PURE__*/React.createElement(RatingBtn, {
    label: "Hard",
    interval: card.pred.hard,
    color: T.rateHard,
    onClick: () => rate('hard')
  }), /*#__PURE__*/React.createElement(RatingBtn, {
    label: "Good",
    interval: card.pred.good,
    color: T.rateGood,
    onClick: () => rate('good')
  }), /*#__PURE__*/React.createElement(RatingBtn, {
    label: "Easy",
    interval: card.pred.easy,
    color: T.rateEasy,
    onClick: () => rate('easy')
  })) : /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: 62,
      fontFamily: T.sans,
      fontSize: 13,
      color: T.ink3,
      gap: 14
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      gap: 5,
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement(Ion, {
    name: "bulb-outline",
    size: 15
  }), "Hint"), /*#__PURE__*/React.createElement("span", {
    style: {
      opacity: 0.4
    }
  }, "\xB7"), /*#__PURE__*/React.createElement("span", null, "swipe to rate after revealing"))), snack && /*#__PURE__*/React.createElement(Snackbar, {
    text: snack.text,
    onUndo: snack.undo ? undo : null
  }), /*#__PURE__*/React.createElement(Sheet, {
    open: moreOpen,
    onClose: () => setMoreOpen(false),
    title: card.base
  }, /*#__PURE__*/React.createElement(ListRow, {
    icon: "repeat",
    title: "Reschedule",
    sub: "Set when you'll see this next \xB7 difficulty unchanged",
    onClick: () => {
      setMoreOpen(false);
      setSnack({
        text: 'Reschedule — pick the next review date',
        undo: false
      });
    }
  }), /*#__PURE__*/React.createElement(ListRow, {
    icon: "eye-off-outline",
    title: "Bury for now",
    sub: "Skip today without changing its schedule",
    onClick: () => {
      setMoreOpen(false);
      setSnack({
        text: `${card.base} buried until tomorrow`,
        undo: true
      });
    }
  }), /*#__PURE__*/React.createElement(ListRow, {
    icon: "flag-outline",
    title: "Flag",
    sub: "Bookmark for later \u2014 no effect on scheduling",
    onClick: () => {
      setMoreOpen(false);
      setSnack({
        text: `${card.base} flagged`,
        undo: true
      });
    }
  }), /*#__PURE__*/React.createElement(ListRow, {
    icon: "swap-horizontal",
    title: "Switch mode",
    sub: "Flashcard \xB7 typing \xB7 multiple choice",
    onClick: () => {
      setMoreOpen(false);
      setSnack({
        text: 'Mode switch — flashcard · typing · quiz',
        undo: false
      });
    },
    last: true
  })), /*#__PURE__*/React.createElement(Sheet, {
    open: confirmExit,
    onClose: () => setConfirmExit(false),
    title: "End this session?"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontSize: 14.5,
      color: T.ink2,
      marginBottom: 18,
      lineHeight: 1.5
    }
  }, "The ", reviewed, " ", reviewed === 1 ? 'card' : 'cards', " you reviewed will be saved."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement(Btn, {
    kind: "secondary",
    full: true,
    onClick: () => setConfirmExit(false)
  }, "Keep studying"), /*#__PURE__*/React.createElement(Btn, {
    full: true,
    onClick: () => {
      setConfirmExit(false);
      onExit();
    }
  }, "End session"))));
}
Object.assign(window, {
  SessionScreen,
  RatingBtn
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/app-v2/screen-session.jsx", error: String((e && e.message) || e) }); }

// ui_kits/app-v2/screen-settings.jsx
try { (() => {
/* Settings — a grouped, searchable hub (E1) with unmistakable resets (E2).
   Search jumps to any control; everyday groups first, Advanced (Beta) and the
   danger zone last; long operations show inline progress, never a blocked
   screen (E3); the factory reset enumerates exactly what it destroys. */

function SettingsScreen({
  theme,
  onTheme,
  onImport,
  onReplayTour,
  onSnack
}) {
  const {
    useState
  } = React;
  const [q, setQ] = useState('');
  const [drill, setDrill] = useState(null); // 'study' | 'algorithm'
  const [eraseOpen, setEraseOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const match = (...words) => !q || words.some(w => w.toLowerCase().includes(q.toLowerCase()));
  const doExport = () => {
    setExporting(true);
    setTimeout(() => {
      setExporting(false);
      onSnack('Backup exported — maranki-backup.json');
    }, 1400);
  };
  if (drill === 'study') return /*#__PURE__*/React.createElement(StudyPrefs, {
    onBack: () => setDrill(null)
  });
  if (drill === 'algorithm') return /*#__PURE__*/React.createElement(AlgorithmPrefs, {
    onBack: () => setDrill(null)
  });
  return /*#__PURE__*/React.createElement(Page, null, /*#__PURE__*/React.createElement(ScreenHead, {
    title: "Settings"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 9,
      background: T.card,
      border: `1px solid ${T.hairStrong}`,
      borderRadius: 999,
      padding: '10px 16px',
      margin: '12px 0 4px'
    }
  }, /*#__PURE__*/React.createElement(Ion, {
    name: "search",
    size: 16,
    color: T.ink3
  }), /*#__PURE__*/React.createElement("input", {
    value: q,
    onChange: e => setQ(e.target.value),
    placeholder: "Search settings\u2026",
    style: {
      flex: 1,
      border: 'none',
      background: 'none',
      fontFamily: T.sans,
      fontSize: 14,
      color: T.ink
    }
  }), q && /*#__PURE__*/React.createElement(Ion, {
    name: "close-circle",
    size: 16,
    color: T.ink3,
    style: {
      cursor: 'pointer'
    },
    onClick: () => setQ('')
  })), match('theme', 'appearance', 'dark', 'evening', 'light') && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(SectionHead, null, "Appearance"), /*#__PURE__*/React.createElement(SegCtrl, {
    value: theme,
    onChange: onTheme,
    options: [{
      id: 'light',
      label: 'Paper',
      icon: 'sunny-outline'
    }, {
      id: 'dark',
      label: 'Evening',
      icon: 'moon-outline'
    }, {
      id: 'system',
      label: 'System',
      icon: 'phone-portrait-outline'
    }]
  })), (match('learning', 'study', 'goals', 'daily', 'mode', 'hints') || match('language')) && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(SectionHead, null, "Learning"), match('learning', 'study', 'goals', 'daily', 'mode', 'hints') && /*#__PURE__*/React.createElement(ListRow, {
    icon: "school-outline",
    title: "Study & goals",
    sub: "30 reviews \xB7 10 new per day \xB7 flashcards \xB7 hints on",
    onClick: () => setDrill('study')
  }), match('language') && /*#__PURE__*/React.createElement(ListRow, {
    icon: "globe-outline",
    title: "Languages",
    sub: "Interface English \xB7 learning German",
    onClick: () => onSnack('Language picker')
  }), match('reminders', 'notifications') && /*#__PURE__*/React.createElement(ListRow, {
    icon: "notifications-outline",
    title: "Reminders",
    sub: "Daily at 9:00 PM \xB7 next: tomorrow",
    last: true,
    right: /*#__PURE__*/React.createElement(Toggle, {
      on: true,
      onChange: () => onSnack('Reminders updated')
    })
  })), match('pronunciation', 'audio', 'speech', 'freeze', 'streak') && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(SectionHead, null, "Habit & speech"), match('pronunciation', 'audio', 'speech') && /*#__PURE__*/React.createElement(ListRow, {
    icon: "mic-outline",
    title: "Pronunciation practice",
    sub: "Prompt on hard cards",
    right: /*#__PURE__*/React.createElement(Toggle, {
      on: true,
      onChange: () => onSnack('Pronunciation setting updated')
    })
  }), match('audio', 'speech') && /*#__PURE__*/React.createElement(ListRow, {
    icon: "volume-high-outline",
    title: "Auto-play audio",
    sub: "Speak the word on reveal",
    right: /*#__PURE__*/React.createElement(Toggle, {
      on: false,
      onChange: () => onSnack('Auto-play updated')
    })
  }), match('freeze', 'streak') && /*#__PURE__*/React.createElement(ListRow, {
    icon: "snow-outline",
    iconColor: T.info,
    iconBg: T.infoTint,
    title: "Streak freezes",
    sub: "2 available \xB7 earn one at every 7-day milestone",
    last: true,
    right: /*#__PURE__*/React.createElement(Pill, {
      mono: true
    }, "2")
  })), match('data', 'import', 'export', 'backup', 'restore') && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(SectionHead, null, "Your data"), /*#__PURE__*/React.createElement(ListRow, {
    icon: "cloud-download-outline",
    title: "Import",
    sub: "CSV \xB7 Anki file \xB7 AnkiWeb",
    onClick: onImport
  }), /*#__PURE__*/React.createElement(ListRow, {
    icon: "cloud-upload-outline",
    title: "Export a backup",
    sub: "Everything \u2014 cards, progress, settings",
    onClick: exporting ? undefined : doExport,
    right: exporting ? /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: T.sans,
        fontSize: 12.5,
        fontWeight: 700,
        color: T.pine
      }
    }, "Exporting\u2026") : /*#__PURE__*/React.createElement(Ion, {
      name: "chevron-forward",
      size: 16,
      color: T.ink3
    })
  }), /*#__PURE__*/React.createElement(ListRow, {
    icon: "refresh-circle-outline",
    title: "Restore a backup",
    sub: "From a Maranki JSON file",
    last: true,
    onClick: () => onSnack('Choose a backup file to restore')
  })), match('advanced', 'algorithm', 'sm2', 'ease', 'steps', 'beta') && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(SectionHead, null, "Advanced"), /*#__PURE__*/React.createElement(ListRow, {
    icon: "options-outline",
    iconColor: T.warning,
    iconBg: T.warningTint,
    title: "Algorithm tuning",
    sub: "Beta \u2014 changes how cards are scheduled",
    onClick: () => setDrill('algorithm'),
    last: true
  })), match('help', 'tour', 'about', 'faq') && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(SectionHead, null, "Help"), /*#__PURE__*/React.createElement(ListRow, {
    icon: "help-buoy-outline",
    title: "Help & FAQ",
    onClick: () => onSnack('Help center')
  }), /*#__PURE__*/React.createElement(ListRow, {
    icon: "play-circle-outline",
    title: "Replay the tour",
    sub: "Re-run first-time setup",
    onClick: onReplayTour,
    last: true
  })), match('reset', 'erase', 'delete', 'danger') && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(SectionHead, null, "Danger zone"), /*#__PURE__*/React.createElement("div", {
    style: {
      border: `1px solid ${softTint(T.danger, 30)}`,
      borderRadius: 14,
      padding: '2px 14px',
      background: softTint(T.danger, 4)
    }
  }, /*#__PURE__*/React.createElement(ListRow, {
    icon: "refresh-outline",
    danger: true,
    title: "Reset preferences to defaults",
    sub: "Keeps every card, deck, streak and session",
    onClick: () => onSnack('Preferences reset — your study data is untouched')
  }), /*#__PURE__*/React.createElement(ListRow, {
    icon: "trash-outline",
    danger: true,
    title: "Erase everything & start over",
    sub: "Deletes all content and settings",
    last: true,
    onClick: () => setEraseOpen(true)
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: 'center',
      fontFamily: T.mono,
      fontSize: 11.5,
      color: T.ink3,
      padding: '26px 0 4px'
    }
  }, "Maranki 2.0 \xB7 made with care"), /*#__PURE__*/React.createElement(Sheet, {
    open: eraseOpen,
    onClose: () => setEraseOpen(false),
    title: "Erase everything?"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontSize: 14,
      color: T.ink2,
      lineHeight: 1.5,
      marginBottom: 12
    }
  }, "This is a factory reset. It permanently deletes:"), /*#__PURE__*/React.createElement("div", {
    style: {
      background: T.dangerTint,
      borderRadius: 14,
      padding: '13px 16px',
      marginBottom: 16
    }
  }, ['5 decks and 1,240 cards', 'All scheduling progress and 286 sessions', `Your ${PERSON.streak}-day streak and level ${PERSON.level}`, 'Every setting, theme and reminder'].map(s => /*#__PURE__*/React.createElement("div", {
    key: s,
    style: {
      display: 'flex',
      gap: 8,
      alignItems: 'center',
      padding: '4px 0',
      fontFamily: T.sans,
      fontSize: 13.5,
      color: T.danger
    }
  }, /*#__PURE__*/React.createElement(Ion, {
    name: "close-circle",
    size: 15
  }), s))), /*#__PURE__*/React.createElement(Btn, {
    kind: "secondary",
    full: true,
    icon: "cloud-upload-outline",
    onClick: () => {
      setEraseOpen(false);
      onSnack('Backup exported — maranki-backup.json');
    },
    style: {
      marginBottom: 10
    }
  }, "Export a backup first"), /*#__PURE__*/React.createElement(Btn, {
    kind: "dangerSolid",
    full: true,
    onClick: () => {
      setEraseOpen(false);
      onSnack('Nothing was erased — this is a demo');
    }
  }, "Hold to erase everything"), /*#__PURE__*/React.createElement("button", {
    onClick: () => setEraseOpen(false),
    style: {
      display: 'block',
      margin: '14px auto 0',
      background: 'none',
      border: 'none',
      cursor: 'pointer',
      fontFamily: T.sans,
      fontWeight: 700,
      fontSize: 14,
      color: T.ink2
    }
  }, "Keep my data")));
}

/* drill-in: study & goals */
function StudyPrefs({
  onBack
}) {
  const {
    useState
  } = React;
  const [reviews, setReviews] = useState(30);
  const [neww, setNeww] = useState(10);
  const [limit, setLimit] = useState(50);
  const [mode, setMode] = useState('flash');
  const [hints, setHints] = useState(true);
  const [retry, setRetry] = useState(true);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      inset: 0,
      background: T.paper,
      zIndex: 45
    }
  }, /*#__PURE__*/React.createElement(StackBar, {
    title: "Study & goals",
    onBack: onBack
  }), /*#__PURE__*/React.createElement("div", {
    className: "mk-scroll",
    style: {
      position: 'absolute',
      top: TOPPAD + 48,
      bottom: 0,
      left: 0,
      right: 0,
      overflowY: 'auto',
      padding: `8px 20px ${TABH + 20}px`
    }
  }, /*#__PURE__*/React.createElement(SectionHead, null, "Daily goal"), /*#__PURE__*/React.createElement(Row, {
    pad: "12px 0"
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      fontFamily: T.sans,
      fontSize: 14.5,
      color: T.ink
    }
  }, "Reviews per day"), /*#__PURE__*/React.createElement(Stepper, {
    value: reviews,
    onChange: setReviews,
    min: 0,
    max: 500,
    step: 10
  })), /*#__PURE__*/React.createElement(Row, {
    pad: "12px 0"
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      fontFamily: T.sans,
      fontSize: 14.5,
      color: T.ink
    }
  }, "New cards per day"), /*#__PURE__*/React.createElement(Stepper, {
    value: neww,
    onChange: setNeww,
    min: 0,
    max: 100,
    step: 5
  })), /*#__PURE__*/React.createElement(Row, {
    pad: "12px 0",
    last: true
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      fontFamily: T.sans,
      fontSize: 14.5,
      color: T.ink
    }
  }, "Session limit"), /*#__PURE__*/React.createElement(Stepper, {
    value: limit,
    onChange: setLimit,
    min: 5,
    max: 100,
    step: 5
  })), /*#__PURE__*/React.createElement(SectionHead, null, "Study mode"), /*#__PURE__*/React.createElement(SegCtrl, {
    value: mode,
    onChange: setMode,
    options: [{
      id: 'flash',
      label: 'Cards'
    }, {
      id: 'type',
      label: 'Typing'
    }, {
      id: 'mc',
      label: 'Quiz'
    }, {
      id: 'mix',
      label: 'Mixed'
    }]
  }), /*#__PURE__*/React.createElement(SectionHead, null, "Behavior"), /*#__PURE__*/React.createElement(Row, {
    pad: "12px 0"
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      fontFamily: T.sans,
      fontSize: 14.5,
      color: T.ink
    }
  }, "Hints"), /*#__PURE__*/React.createElement(Toggle, {
    on: hints,
    onChange: setHints
  })), /*#__PURE__*/React.createElement(Row, {
    pad: "12px 0",
    last: true
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontSize: 14.5,
      color: T.ink
    }
  }, "Retry missed cards"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontSize: 12.5,
      color: T.ink3
    }
  }, "An extra round at the end of a session")), /*#__PURE__*/React.createElement(Toggle, {
    on: retry,
    onChange: setRetry
  }))));
}

/* drill-in: algorithm tuning — steppers + plain language + per-knob reset (E4) */
function AlgorithmPrefs({
  onBack
}) {
  const {
    useState
  } = React;
  const [easy, setEasy] = useState(1.3);
  const [hard, setHard] = useState(0.85);
  const knob = (label, plain, val, set, min, max, step, dflt, fmt) => /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '14px 0',
      borderBottom: `1px solid ${T.hairSoft}`
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontWeight: 650,
      fontSize: 14.5,
      color: T.ink
    }
  }, label), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontSize: 12.5,
      color: T.ink3,
      marginTop: 2
    }
  }, plain)), /*#__PURE__*/React.createElement(Stepper, {
    value: val,
    onChange: n => set(Math.round(n * 100) / 100),
    min: min,
    max: max,
    step: step,
    fmt: fmt
  })), val !== dflt && /*#__PURE__*/React.createElement("button", {
    onClick: () => set(dflt),
    style: {
      background: 'none',
      border: 'none',
      cursor: 'pointer',
      fontFamily: T.sans,
      fontSize: 12,
      fontWeight: 700,
      color: T.pine,
      padding: '6px 0 0'
    }
  }, "Reset to default (", fmt(dflt), ")"));
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      inset: 0,
      background: T.paper,
      zIndex: 45
    }
  }, /*#__PURE__*/React.createElement(StackBar, {
    title: "Algorithm tuning",
    sub: "Beta \u2014 changes apply instantly",
    onBack: onBack
  }), /*#__PURE__*/React.createElement("div", {
    className: "mk-scroll",
    style: {
      position: 'absolute',
      top: TOPPAD + 48,
      bottom: 0,
      left: 0,
      right: 0,
      overflowY: 'auto',
      padding: `14px 20px ${TABH + 20}px`
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 10,
      alignItems: 'flex-start',
      background: T.warningTint,
      borderRadius: 12,
      padding: '11px 14px',
      fontFamily: T.sans,
      fontSize: 13,
      color: T.ink,
      lineHeight: 1.45
    }
  }, /*#__PURE__*/React.createElement(Ion, {
    name: "warning-outline",
    size: 17,
    color: T.warning,
    style: {
      marginTop: 1
    }
  }), "These knobs reshape your review schedule. The defaults work well for most learners."), knob('Easy bonus', `Easy cards wait ${Math.round((easy - 1) * 100)}% longer`, easy, setEasy, 1.0, 3.0, 0.05, 1.3, n => `${n.toFixed(2)}×`), knob('Hard penalty', `Hard cards grow ${Math.round((1 - hard) * 100)}% slower`, hard, setHard, 0.5, 1.0, 0.05, 0.85, n => `${n.toFixed(2)}×`), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '14px 0'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontWeight: 650,
      fontSize: 14.5,
      color: T.ink,
      marginBottom: 8
    }
  }, "Learning steps"), /*#__PURE__*/React.createElement(SegCtrl, {
    value: "standard",
    onChange: () => {},
    options: [{
      id: 'relaxed',
      label: 'Relaxed'
    }, {
      id: 'standard',
      label: 'Standard'
    }, {
      id: 'intensive',
      label: 'Intensive'
    }]
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.mono,
      fontSize: 12,
      color: T.ink3,
      marginTop: 8
    }
  }, "steps: 1m \u2192 10m \xB7 graduate at 1d"))));
}
Object.assign(window, {
  SettingsScreen,
  StudyPrefs,
  AlgorithmPrefs
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/app-v2/screen-settings.jsx", error: String((e && e.message) || e) }); }

// ui_kits/app-v2/screen-stats.jsx
try { (() => {
/* Progress (Stats) — progression that drives action (C1 + C5).
   Level + XP at the top, the streak and mastery heroes, every high-intent
   number a launcher (due → study, weak cards → review), an honest activity
   heatmap, the achievements wall, and a quiet all-time ledger. */

function HeatCell({
  v
}) {
  const colors = ['transparent', softTint(T.pine, 18), softTint(T.pine, 38), softTint(T.pine, 65), T.pine];
  return /*#__PURE__*/React.createElement("div", {
    style: {
      width: '100%',
      aspectRatio: '1',
      borderRadius: 5,
      background: colors[v],
      border: v === 0 ? `1px solid ${T.hairSoft}` : 'none',
      boxSizing: 'border-box'
    }
  });
}
function StatsScreen({
  onStartSession,
  onSnack
}) {
  const {
    useState
  } = React;
  const [range, setRange] = useState('5w');
  return /*#__PURE__*/React.createElement(Page, null, /*#__PURE__*/React.createElement(ScreenHead, {
    title: "Progress",
    sub: "Level, habit, and mastery \u2014 all in one place.",
    right: /*#__PURE__*/React.createElement(IconBtn, {
      icon: "download-outline",
      size: 36,
      iconSize: 17,
      border: true,
      onClick: () => onSnack('Exported study history (CSV)')
    })
  }), /*#__PURE__*/React.createElement(Card, {
    style: {
      marginTop: 14,
      display: 'flex',
      alignItems: 'center',
      gap: 14,
      padding: '14px 16px'
    }
  }, /*#__PURE__*/React.createElement(Ring, {
    value: 62,
    size: 52,
    stroke: 4.5,
    color: T.amber
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: T.sans,
      fontWeight: 800,
      fontSize: 17,
      color: T.ink,
      fontFeatureSettings: "'tnum' 1"
    }
  }, PERSON.level)), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontWeight: 750,
      fontSize: 15.5,
      color: T.ink
    }
  }, "Level ", PERSON.level, " \xB7 ", PERSON.levelName), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontSize: 12.5,
      color: T.ink3,
      fontFeatureSettings: "'tnum' 1"
    }
  }, PERSON.xpNext, " XP to level ", PERSON.level + 1)), /*#__PURE__*/React.createElement(Pill, {
    mono: true,
    fg: T.amberDeep,
    bg: T.amberTint
  }, PERSON.xp.toLocaleString('en-US'), " XP")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: 12,
      marginTop: 12
    }
  }, /*#__PURE__*/React.createElement(Card, {
    pad: 16
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 6
    }
  }, /*#__PURE__*/React.createElement(Ion, {
    name: "flame",
    size: 16,
    color: T.amber
  }), /*#__PURE__*/React.createElement(Overline, null, "Streak")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'baseline',
      gap: 5,
      margin: '8px 0 2px'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: T.sans,
      fontWeight: 800,
      fontSize: 34,
      letterSpacing: '-0.03em',
      color: T.ink,
      fontFeatureSettings: "'tnum' 1"
    }
  }, PERSON.streak), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: T.sans,
      fontSize: 13,
      color: T.ink3
    }
  }, "days")), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontSize: 12,
      color: T.ink3
    }
  }, "best ", PERSON.best, " \xB7 ", /*#__PURE__*/React.createElement(Ion, {
    name: "snow",
    size: 10,
    color: T.info
  }), " ", PERSON.freezes, " freezes"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 3,
      marginTop: 11
    }
  }, DAYS14.slice(-7).map((d, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      flex: 1,
      height: 5,
      borderRadius: 99,
      background: d === 's' || d === 't' ? T.amber : d === 'f' ? T.info : T.paperSunk
    }
  })))), /*#__PURE__*/React.createElement(Card, {
    pad: 16
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 6
    }
  }, /*#__PURE__*/React.createElement(Ion, {
    name: "checkmark-circle",
    size: 16,
    color: T.pine
  }), /*#__PURE__*/React.createElement(Overline, null, "Mastered")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      marginTop: 8
    }
  }, /*#__PURE__*/React.createElement(Ring, {
    value: PERSON.masteryPct,
    size: 56,
    stroke: 5
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: T.sans,
      fontWeight: 800,
      fontSize: 14.5,
      color: T.ink,
      fontFeatureSettings: "'tnum' 1"
    }
  }, PERSON.masteryPct, "%")), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontSize: 12,
      color: T.ink3,
      lineHeight: 1.5,
      fontFeatureSettings: "'tnum' 1"
    }
  }, PERSON.masteredCards, /*#__PURE__*/React.createElement("br", null), "of ", PERSON.totalCards.toLocaleString('en-US'))))), /*#__PURE__*/React.createElement(SectionHead, null, "Today"), /*#__PURE__*/React.createElement(Row, {
    onClick: onStartSession,
    pad: "13px 0"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 34,
      height: 34,
      borderRadius: 10,
      background: T.pineTint,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flex: 'none'
    }
  }, /*#__PURE__*/React.createElement(Ion, {
    name: "time-outline",
    size: 17,
    color: T.pine
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontWeight: 700,
      fontSize: 14.5,
      color: T.ink
    }
  }, READY.due, " cards due"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontSize: 12.5,
      color: T.ink3
    }
  }, PERSON.studiedToday, " studied so far today")), /*#__PURE__*/React.createElement(Btn, {
    size: "sm"
  }, "Start")), /*#__PURE__*/React.createElement(Row, {
    onClick: () => onSnack('Queued 11 weak cards for review'),
    pad: "13px 0",
    last: true
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 34,
      height: 34,
      borderRadius: 10,
      background: T.warningTint,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flex: 'none'
    }
  }, /*#__PURE__*/React.createElement(Ion, {
    name: "trending-down",
    size: 17,
    color: T.warning
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontWeight: 700,
      fontSize: 14.5,
      color: T.ink
    }
  }, "Retention dipped to ", PERSON.retention, "%"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontSize: 12.5,
      color: T.ink3
    }
  }, "11 weak cards could use a review")), /*#__PURE__*/React.createElement(Btn, {
    size: "sm",
    kind: "secondary"
  }, "Review")), /*#__PURE__*/React.createElement(SectionHead, {
    action: /*#__PURE__*/React.createElement(SegCtrl, {
      size: "sm",
      options: [{
        id: '5w',
        label: '5 weeks'
      }, {
        id: 'y',
        label: 'Year'
      }],
      value: range,
      onChange: setRange
    })
  }, "Activity"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(7, 1fr)',
      gap: 5,
      padding: '10px 0 6px'
    }
  }, HEAT.flat().map((v, i) => /*#__PURE__*/React.createElement(HeatCell, {
    key: i,
    v: range === 'y' ? Math.max(0, v - 1) : v
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'space-between',
      fontFamily: T.sans,
      fontSize: 11.5,
      color: T.ink3
    }
  }, /*#__PURE__*/React.createElement("span", null, range === '5w' ? 'May 5' : 'Jun 2025'), /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4
    }
  }, "less", [0, 1, 2, 3, 4].map(v => /*#__PURE__*/React.createElement("span", {
    key: v,
    style: {
      width: 9,
      height: 9,
      borderRadius: 3,
      background: v === 0 ? T.paperSunk : softTint(T.pine, [0, 18, 38, 65, 100][v])
    }
  })), "more"), /*#__PURE__*/React.createElement("span", null, "today")), /*#__PURE__*/React.createElement(SectionHead, null, "By level"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 11,
      padding: '8px 0 2px'
    }
  }, [['A1', 92], ['A2', 81], ['B1', 56], ['B2', 23]].map(([l, p]) => /*#__PURE__*/React.createElement("div", {
    key: l,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 12
    }
  }, /*#__PURE__*/React.createElement(LevelBadge, {
    level: l
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement(Bar, {
    value: p,
    color: CEFR[l][0]
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: T.mono,
      fontSize: 12,
      color: T.ink3,
      width: 34,
      textAlign: 'right'
    }
  }, p, "%")))), /*#__PURE__*/React.createElement(SectionHead, {
    action: /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: T.mono,
        fontSize: 12,
        color: T.ink3
      }
    }, "4/8")
  }, "Achievements"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(4, 1fr)',
      gap: 12,
      padding: '10px 0 4px'
    }
  }, ACHIEVEMENTS.map(a => /*#__PURE__*/React.createElement("div", {
    key: a.id,
    style: {
      textAlign: 'center'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 52,
      height: 52,
      borderRadius: 16,
      margin: '0 auto 7px',
      background: a.unlocked ? T.amber : T.paperSunk,
      border: a.unlocked ? 'none' : `1px dashed ${T.hairStrong}`,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      boxShadow: a.unlocked ? T.shSm : 'none'
    }
  }, /*#__PURE__*/React.createElement(Ion, {
    name: a.unlocked ? a.icon : 'lock-closed',
    size: 21,
    color: a.unlocked ? '#fff' : T.ink3
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontWeight: 650,
      fontSize: 11,
      color: a.unlocked ? T.ink : T.ink3,
      lineHeight: 1.25
    }
  }, a.name), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.mono,
      fontSize: 10,
      color: T.ink3,
      marginTop: 1
    }
  }, a.unlocked ? a.date : `${a.prog}/${a.goal}`)))), /*#__PURE__*/React.createElement(SectionHead, null, "All time"), /*#__PURE__*/React.createElement("div", null, [['Total reviews', '12,418'], ['Sessions', '286'], ['Average per session', '23 cards'], ['Days active', '164']].map(([l, n], i, arr) => /*#__PURE__*/React.createElement(Row, {
    key: l,
    pad: "11px 0",
    last: i === arr.length - 1
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      fontFamily: T.sans,
      fontSize: 14,
      color: T.ink2
    }
  }, l), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: T.mono,
      fontSize: 13.5,
      color: T.ink,
      fontFeatureSettings: "'tnum' 1"
    }
  }, n)))));
}
Object.assign(window, {
  StatsScreen,
  HeatCell
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/app-v2/screen-stats.jsx", error: String((e && e.message) || e) }); }

// ui_kits/app-v2/tweaks-panel.jsx
try { (() => {
// @ds-adherence-ignore -- omelette starter scaffold (raw elements/hex/px by design)

/* BEGIN USAGE */
// tweaks-panel.jsx
// Reusable Tweaks shell + form-control helpers.
// Exports (to window): useTweaks, TweaksPanel, TweakSection, TweakRow, TweakSlider,
//   TweakToggle, TweakRadio, TweakSelect, TweakText, TweakNumber, TweakColor, TweakButton.
//
// Owns the host protocol (listens for __activate_edit_mode / __deactivate_edit_mode,
// posts __edit_mode_available / __edit_mode_set_keys / __edit_mode_dismissed) so
// individual prototypes don't re-roll it. Ships a consistent set of controls so you
// don't hand-draw <input type="range">, segmented radios, steppers, etc.
//
// Usage (in an HTML file that loads React + Babel):
//
//   const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
//     "primaryColor": "#D97757",
//     "palette": ["#D97757", "#29261b", "#f6f4ef"],
//     "fontSize": 16,
//     "density": "regular",
//     "dark": false
//   }/*EDITMODE-END*/;
//
//   function App() {
//     const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
//     return (
//       <div style={{ fontSize: t.fontSize, color: t.primaryColor }}>
//         Hello
//         <TweaksPanel>
//           <TweakSection label="Typography" />
//           <TweakSlider label="Font size" value={t.fontSize} min={10} max={32} unit="px"
//                        onChange={(v) => setTweak('fontSize', v)} />
//           <TweakRadio  label="Density" value={t.density}
//                        options={['compact', 'regular', 'comfy']}
//                        onChange={(v) => setTweak('density', v)} />
//           <TweakSection label="Theme" />
//           <TweakColor  label="Primary" value={t.primaryColor}
//                        options={['#D97757', '#2A6FDB', '#1F8A5B', '#7A5AE0']}
//                        onChange={(v) => setTweak('primaryColor', v)} />
//           <TweakColor  label="Palette" value={t.palette}
//                        options={[['#D97757', '#29261b', '#f6f4ef'],
//                                  ['#475569', '#0f172a', '#f1f5f9']]}
//                        onChange={(v) => setTweak('palette', v)} />
//           <TweakToggle label="Dark mode" value={t.dark}
//                        onChange={(v) => setTweak('dark', v)} />
//         </TweaksPanel>
//       </div>
//     );
//   }
//
// TweakRadio is the segmented control for 2–3 short options (auto-falls-back to
// TweakSelect past ~16/~10 chars per label); reach for TweakSelect directly when
// options are many or long. For color tweaks always curate 3-4 options rather than
// a free picker; an option can also be a whole 2–5 color palette (the stored value
// is the array). The Tweak* controls are a floor, not a ceiling — build custom
// controls inside the panel if a tweak calls for UI they don't cover.
/* END USAGE */
// ─────────────────────────────────────────────────────────────────────────────

const __TWEAKS_STYLE = `
  .twk-panel{position:fixed;right:16px;bottom:16px;z-index:2147483646;width:280px;
    max-height:calc(100vh - 32px);display:flex;flex-direction:column;
    transform:scale(var(--dc-inv-zoom,1));transform-origin:bottom right;
    background:rgba(250,249,247,.78);color:#29261b;
    -webkit-backdrop-filter:blur(24px) saturate(160%);backdrop-filter:blur(24px) saturate(160%);
    border:.5px solid rgba(255,255,255,.6);border-radius:14px;
    box-shadow:0 1px 0 rgba(255,255,255,.5) inset,0 12px 40px rgba(0,0,0,.18);
    font:11.5px/1.4 ui-sans-serif,system-ui,-apple-system,sans-serif;overflow:hidden}
  .twk-hd{display:flex;align-items:center;justify-content:space-between;
    padding:10px 8px 10px 14px;cursor:move;user-select:none}
  .twk-hd b{font-size:12px;font-weight:600;letter-spacing:.01em}
  .twk-x{appearance:none;border:0;background:transparent;color:rgba(41,38,27,.55);
    width:22px;height:22px;border-radius:6px;cursor:default;font-size:13px;line-height:1}
  .twk-x:hover{background:rgba(0,0,0,.06);color:#29261b}
  .twk-body{padding:2px 14px 14px;display:flex;flex-direction:column;gap:10px;
    overflow-y:auto;overflow-x:hidden;min-height:0;
    scrollbar-width:thin;scrollbar-color:rgba(0,0,0,.15) transparent}
  .twk-body::-webkit-scrollbar{width:8px}
  .twk-body::-webkit-scrollbar-track{background:transparent;margin:2px}
  .twk-body::-webkit-scrollbar-thumb{background:rgba(0,0,0,.15);border-radius:4px;
    border:2px solid transparent;background-clip:content-box}
  .twk-body::-webkit-scrollbar-thumb:hover{background:rgba(0,0,0,.25);
    border:2px solid transparent;background-clip:content-box}
  .twk-row{display:flex;flex-direction:column;gap:5px}
  .twk-row-h{flex-direction:row;align-items:center;justify-content:space-between;gap:10px}
  .twk-lbl{display:flex;justify-content:space-between;align-items:baseline;
    color:rgba(41,38,27,.72)}
  .twk-lbl>span:first-child{font-weight:500}
  .twk-val{color:rgba(41,38,27,.5);font-variant-numeric:tabular-nums}

  .twk-sect{font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;
    color:rgba(41,38,27,.45);padding:10px 0 0}
  .twk-sect:first-child{padding-top:0}

  .twk-field{appearance:none;box-sizing:border-box;width:100%;min-width:0;height:26px;padding:0 8px;
    border:.5px solid rgba(0,0,0,.1);border-radius:7px;
    background:rgba(255,255,255,.6);color:inherit;font:inherit;outline:none}
  .twk-field:focus{border-color:rgba(0,0,0,.25);background:rgba(255,255,255,.85)}
  select.twk-field{padding-right:22px;
    background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path fill='rgba(0,0,0,.5)' d='M0 0h10L5 6z'/></svg>");
    background-repeat:no-repeat;background-position:right 8px center}

  .twk-slider{appearance:none;-webkit-appearance:none;width:100%;height:4px;margin:6px 0;
    border-radius:999px;background:rgba(0,0,0,.12);outline:none}
  .twk-slider::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;
    width:14px;height:14px;border-radius:50%;background:#fff;
    border:.5px solid rgba(0,0,0,.12);box-shadow:0 1px 3px rgba(0,0,0,.2);cursor:default}
  .twk-slider::-moz-range-thumb{width:14px;height:14px;border-radius:50%;
    background:#fff;border:.5px solid rgba(0,0,0,.12);box-shadow:0 1px 3px rgba(0,0,0,.2);cursor:default}

  .twk-seg{position:relative;display:flex;padding:2px;border-radius:8px;
    background:rgba(0,0,0,.06);user-select:none}
  .twk-seg-thumb{position:absolute;top:2px;bottom:2px;border-radius:6px;
    background:rgba(255,255,255,.9);box-shadow:0 1px 2px rgba(0,0,0,.12);
    transition:left .15s cubic-bezier(.3,.7,.4,1),width .15s}
  .twk-seg.dragging .twk-seg-thumb{transition:none}
  .twk-seg button{appearance:none;position:relative;z-index:1;flex:1;border:0;
    background:transparent;color:inherit;font:inherit;font-weight:500;min-height:22px;
    border-radius:6px;cursor:default;padding:4px 6px;line-height:1.2;
    overflow-wrap:anywhere}

  .twk-toggle{position:relative;width:32px;height:18px;border:0;border-radius:999px;
    background:rgba(0,0,0,.15);transition:background .15s;cursor:default;padding:0}
  .twk-toggle[data-on="1"]{background:#34c759}
  .twk-toggle i{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;
    background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .15s}
  .twk-toggle[data-on="1"] i{transform:translateX(14px)}

  .twk-num{display:flex;align-items:center;box-sizing:border-box;min-width:0;height:26px;padding:0 0 0 8px;
    border:.5px solid rgba(0,0,0,.1);border-radius:7px;background:rgba(255,255,255,.6)}
  .twk-num-lbl{font-weight:500;color:rgba(41,38,27,.6);cursor:ew-resize;
    user-select:none;padding-right:8px}
  .twk-num input{flex:1;min-width:0;height:100%;border:0;background:transparent;
    font:inherit;font-variant-numeric:tabular-nums;text-align:right;padding:0 8px 0 0;
    outline:none;color:inherit;-moz-appearance:textfield}
  .twk-num input::-webkit-inner-spin-button,.twk-num input::-webkit-outer-spin-button{
    -webkit-appearance:none;margin:0}
  .twk-num-unit{padding-right:8px;color:rgba(41,38,27,.45)}

  .twk-btn{appearance:none;height:26px;padding:0 12px;border:0;border-radius:7px;
    background:rgba(0,0,0,.78);color:#fff;font:inherit;font-weight:500;cursor:default}
  .twk-btn:hover{background:rgba(0,0,0,.88)}
  .twk-btn.secondary{background:rgba(0,0,0,.06);color:inherit}
  .twk-btn.secondary:hover{background:rgba(0,0,0,.1)}

  .twk-swatch{appearance:none;-webkit-appearance:none;width:56px;height:22px;
    border:.5px solid rgba(0,0,0,.1);border-radius:6px;padding:0;cursor:default;
    background:transparent;flex-shrink:0}
  .twk-swatch::-webkit-color-swatch-wrapper{padding:0}
  .twk-swatch::-webkit-color-swatch{border:0;border-radius:5.5px}
  .twk-swatch::-moz-color-swatch{border:0;border-radius:5.5px}

  .twk-chips{display:flex;gap:6px}
  .twk-chip{position:relative;appearance:none;flex:1;min-width:0;height:46px;
    padding:0;border:0;border-radius:6px;overflow:hidden;cursor:default;
    box-shadow:0 0 0 .5px rgba(0,0,0,.12),0 1px 2px rgba(0,0,0,.06);
    transition:transform .12s cubic-bezier(.3,.7,.4,1),box-shadow .12s}
  .twk-chip:hover{transform:translateY(-1px);
    box-shadow:0 0 0 .5px rgba(0,0,0,.18),0 4px 10px rgba(0,0,0,.12)}
  .twk-chip[data-on="1"]{box-shadow:0 0 0 1.5px rgba(0,0,0,.85),
    0 2px 6px rgba(0,0,0,.15)}
  .twk-chip>span{position:absolute;top:0;bottom:0;right:0;width:34%;
    display:flex;flex-direction:column;box-shadow:-1px 0 0 rgba(0,0,0,.1)}
  .twk-chip>span>i{flex:1;box-shadow:0 -1px 0 rgba(0,0,0,.1)}
  .twk-chip>span>i:first-child{box-shadow:none}
  .twk-chip svg{position:absolute;top:6px;left:6px;width:13px;height:13px;
    filter:drop-shadow(0 1px 1px rgba(0,0,0,.3))}
`;

// ── useTweaks ───────────────────────────────────────────────────────────────
// Single source of truth for tweak values. setTweak persists via the host
// (__edit_mode_set_keys → host rewrites the EDITMODE block on disk).
function useTweaks(defaults) {
  const [values, setValues] = React.useState(defaults);
  // Accepts either setTweak('key', value) or setTweak({ key: value, ... }) so a
  // useState-style call doesn't write a "[object Object]" key into the persisted
  // JSON block.
  const setTweak = React.useCallback((keyOrEdits, val) => {
    const edits = typeof keyOrEdits === 'object' && keyOrEdits !== null ? keyOrEdits : {
      [keyOrEdits]: val
    };
    setValues(prev => ({
      ...prev,
      ...edits
    }));
    window.parent.postMessage({
      type: '__edit_mode_set_keys',
      edits
    }, '*');
    // Same-window signal so in-page listeners (deck-stage rail thumbnails)
    // can react — the parent message only reaches the host, not peers.
    window.dispatchEvent(new CustomEvent('tweakchange', {
      detail: edits
    }));
  }, []);
  return [values, setTweak];
}

// ── TweaksPanel ─────────────────────────────────────────────────────────────
// Floating shell. Registers the protocol listener BEFORE announcing
// availability — if the announce ran first, the host's activate could land
// before our handler exists and the toolbar toggle would silently no-op.
// The close button posts __edit_mode_dismissed so the host's toolbar toggle
// flips off in lockstep; the host echoes __deactivate_edit_mode back which
// is what actually hides the panel.
function TweaksPanel({
  title = 'Tweaks',
  children
}) {
  const [open, setOpen] = React.useState(false);
  const dragRef = React.useRef(null);
  const offsetRef = React.useRef({
    x: 16,
    y: 16
  });
  const PAD = 16;
  const clampToViewport = React.useCallback(() => {
    const panel = dragRef.current;
    if (!panel) return;
    const w = panel.offsetWidth,
      h = panel.offsetHeight;
    const maxRight = Math.max(PAD, window.innerWidth - w - PAD);
    const maxBottom = Math.max(PAD, window.innerHeight - h - PAD);
    offsetRef.current = {
      x: Math.min(maxRight, Math.max(PAD, offsetRef.current.x)),
      y: Math.min(maxBottom, Math.max(PAD, offsetRef.current.y))
    };
    panel.style.right = offsetRef.current.x + 'px';
    panel.style.bottom = offsetRef.current.y + 'px';
  }, []);
  React.useEffect(() => {
    if (!open) return;
    clampToViewport();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', clampToViewport);
      return () => window.removeEventListener('resize', clampToViewport);
    }
    const ro = new ResizeObserver(clampToViewport);
    ro.observe(document.documentElement);
    return () => ro.disconnect();
  }, [open, clampToViewport]);
  React.useEffect(() => {
    const onMsg = e => {
      const t = e?.data?.type;
      if (t === '__activate_edit_mode') setOpen(true);else if (t === '__deactivate_edit_mode') setOpen(false);
    };
    window.addEventListener('message', onMsg);
    window.parent.postMessage({
      type: '__edit_mode_available'
    }, '*');
    return () => window.removeEventListener('message', onMsg);
  }, []);
  const dismiss = () => {
    setOpen(false);
    window.parent.postMessage({
      type: '__edit_mode_dismissed'
    }, '*');
  };
  const onDragStart = e => {
    const panel = dragRef.current;
    if (!panel) return;
    const r = panel.getBoundingClientRect();
    const sx = e.clientX,
      sy = e.clientY;
    const startRight = window.innerWidth - r.right;
    const startBottom = window.innerHeight - r.bottom;
    const move = ev => {
      offsetRef.current = {
        x: startRight - (ev.clientX - sx),
        y: startBottom - (ev.clientY - sy)
      };
      clampToViewport();
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  if (!open) return null;
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("style", null, __TWEAKS_STYLE), /*#__PURE__*/React.createElement("div", {
    ref: dragRef,
    className: "twk-panel",
    "data-omelette-chrome": "",
    style: {
      right: offsetRef.current.x,
      bottom: offsetRef.current.y
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "twk-hd",
    onMouseDown: onDragStart
  }, /*#__PURE__*/React.createElement("b", null, title), /*#__PURE__*/React.createElement("button", {
    className: "twk-x",
    "aria-label": "Close tweaks",
    onMouseDown: e => e.stopPropagation(),
    onClick: dismiss
  }, "\u2715")), /*#__PURE__*/React.createElement("div", {
    className: "twk-body"
  }, children)));
}

// ── Layout helpers ──────────────────────────────────────────────────────────

function TweakSection({
  label,
  children
}) {
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "twk-sect"
  }, label), children);
}
function TweakRow({
  label,
  value,
  children,
  inline = false
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: inline ? 'twk-row twk-row-h' : 'twk-row'
  }, /*#__PURE__*/React.createElement("div", {
    className: "twk-lbl"
  }, /*#__PURE__*/React.createElement("span", null, label), value != null && /*#__PURE__*/React.createElement("span", {
    className: "twk-val"
  }, value)), children);
}

// ── Controls ────────────────────────────────────────────────────────────────

function TweakSlider({
  label,
  value,
  min = 0,
  max = 100,
  step = 1,
  unit = '',
  onChange
}) {
  return /*#__PURE__*/React.createElement(TweakRow, {
    label: label,
    value: `${value}${unit}`
  }, /*#__PURE__*/React.createElement("input", {
    type: "range",
    className: "twk-slider",
    min: min,
    max: max,
    step: step,
    value: value,
    onChange: e => onChange(Number(e.target.value))
  }));
}
function TweakToggle({
  label,
  value,
  onChange
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: "twk-row twk-row-h"
  }, /*#__PURE__*/React.createElement("div", {
    className: "twk-lbl"
  }, /*#__PURE__*/React.createElement("span", null, label)), /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "twk-toggle",
    "data-on": value ? '1' : '0',
    role: "switch",
    "aria-checked": !!value,
    onClick: () => onChange(!value)
  }, /*#__PURE__*/React.createElement("i", null)));
}
function TweakRadio({
  label,
  value,
  options,
  onChange
}) {
  const trackRef = React.useRef(null);
  const [dragging, setDragging] = React.useState(false);
  // The active value is read by pointer-move handlers attached for the lifetime
  // of a drag — ref it so a stale closure doesn't fire onChange for every move.
  const valueRef = React.useRef(value);
  valueRef.current = value;

  // Segments wrap mid-word once per-segment width runs out. The track is
  // ~248px (280 panel − 28 body pad − 4 seg pad), each button loses 12px
  // to its own padding, and 11.5px system-ui averages ~6.3px/char — so 2
  // options fit ~16 chars each, 3 fit ~10. Past that (or >3 options), fall
  // back to a dropdown rather than wrap.
  const labelLen = o => String(typeof o === 'object' ? o.label : o).length;
  const maxLen = options.reduce((m, o) => Math.max(m, labelLen(o)), 0);
  const fitsAsSegments = maxLen <= ({
    2: 16,
    3: 10
  }[options.length] ?? 0);
  if (!fitsAsSegments) {
    // <select> emits strings — map back to the original option value so the
    // fallback stays type-preserving (numbers, booleans) like the segment path.
    const resolve = s => {
      const m = options.find(o => String(typeof o === 'object' ? o.value : o) === s);
      return m === undefined ? s : typeof m === 'object' ? m.value : m;
    };
    return /*#__PURE__*/React.createElement(TweakSelect, {
      label: label,
      value: value,
      options: options,
      onChange: s => onChange(resolve(s))
    });
  }
  const opts = options.map(o => typeof o === 'object' ? o : {
    value: o,
    label: o
  });
  const idx = Math.max(0, opts.findIndex(o => o.value === value));
  const n = opts.length;
  const segAt = clientX => {
    const r = trackRef.current.getBoundingClientRect();
    const inner = r.width - 4;
    const i = Math.floor((clientX - r.left - 2) / inner * n);
    return opts[Math.max(0, Math.min(n - 1, i))].value;
  };
  const onPointerDown = e => {
    setDragging(true);
    const v0 = segAt(e.clientX);
    if (v0 !== valueRef.current) onChange(v0);
    const move = ev => {
      if (!trackRef.current) return;
      const v = segAt(ev.clientX);
      if (v !== valueRef.current) onChange(v);
    };
    const up = () => {
      setDragging(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return /*#__PURE__*/React.createElement(TweakRow, {
    label: label
  }, /*#__PURE__*/React.createElement("div", {
    ref: trackRef,
    role: "radiogroup",
    onPointerDown: onPointerDown,
    className: dragging ? 'twk-seg dragging' : 'twk-seg'
  }, /*#__PURE__*/React.createElement("div", {
    className: "twk-seg-thumb",
    style: {
      left: `calc(2px + ${idx} * (100% - 4px) / ${n})`,
      width: `calc((100% - 4px) / ${n})`
    }
  }), opts.map(o => /*#__PURE__*/React.createElement("button", {
    key: o.value,
    type: "button",
    role: "radio",
    "aria-checked": o.value === value
  }, o.label))));
}
function TweakSelect({
  label,
  value,
  options,
  onChange
}) {
  return /*#__PURE__*/React.createElement(TweakRow, {
    label: label
  }, /*#__PURE__*/React.createElement("select", {
    className: "twk-field",
    value: value,
    onChange: e => onChange(e.target.value)
  }, options.map(o => {
    const v = typeof o === 'object' ? o.value : o;
    const l = typeof o === 'object' ? o.label : o;
    return /*#__PURE__*/React.createElement("option", {
      key: v,
      value: v
    }, l);
  })));
}
function TweakText({
  label,
  value,
  placeholder,
  onChange
}) {
  return /*#__PURE__*/React.createElement(TweakRow, {
    label: label
  }, /*#__PURE__*/React.createElement("input", {
    className: "twk-field",
    type: "text",
    value: value,
    placeholder: placeholder,
    onChange: e => onChange(e.target.value)
  }));
}
function TweakNumber({
  label,
  value,
  min,
  max,
  step = 1,
  unit = '',
  onChange
}) {
  const clamp = n => {
    if (min != null && n < min) return min;
    if (max != null && n > max) return max;
    return n;
  };
  const startRef = React.useRef({
    x: 0,
    val: 0
  });
  const onScrubStart = e => {
    e.preventDefault();
    startRef.current = {
      x: e.clientX,
      val: value
    };
    const decimals = (String(step).split('.')[1] || '').length;
    const move = ev => {
      const dx = ev.clientX - startRef.current.x;
      const raw = startRef.current.val + dx * step;
      const snapped = Math.round(raw / step) * step;
      onChange(clamp(Number(snapped.toFixed(decimals))));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return /*#__PURE__*/React.createElement("div", {
    className: "twk-num"
  }, /*#__PURE__*/React.createElement("span", {
    className: "twk-num-lbl",
    onPointerDown: onScrubStart
  }, label), /*#__PURE__*/React.createElement("input", {
    type: "number",
    value: value,
    min: min,
    max: max,
    step: step,
    onChange: e => onChange(clamp(Number(e.target.value)))
  }), unit && /*#__PURE__*/React.createElement("span", {
    className: "twk-num-unit"
  }, unit));
}

// Relative-luminance contrast pick — checkmarks drawn over a swatch need to
// read on both #111 and #fafafa without per-option configuration. Hex input
// only (#rgb / #rrggbb); named or rgb()/hsl() colors fall through to "light".
function __twkIsLight(hex) {
  const h = String(hex).replace('#', '');
  const x = h.length === 3 ? h.replace(/./g, c => c + c) : h.padEnd(6, '0');
  const n = parseInt(x.slice(0, 6), 16);
  if (Number.isNaN(n)) return true;
  const r = n >> 16 & 255,
    g = n >> 8 & 255,
    b = n & 255;
  return r * 299 + g * 587 + b * 114 > 148000;
}
const __TwkCheck = ({
  light
}) => /*#__PURE__*/React.createElement("svg", {
  viewBox: "0 0 14 14",
  "aria-hidden": "true"
}, /*#__PURE__*/React.createElement("path", {
  d: "M3 7.2 5.8 10 11 4.2",
  fill: "none",
  strokeWidth: "2.2",
  strokeLinecap: "round",
  strokeLinejoin: "round",
  stroke: light ? 'rgba(0,0,0,.78)' : '#fff'
}));

// TweakColor — curated color/palette picker. Each option is either a single
// hex string or an array of 1-5 hex strings; the card adapts — a lone color
// renders solid, a palette renders colors[0] as the hero (left ~2/3) with the
// rest stacked in a sharp column on the right. onChange emits the
// option in the shape it was passed (string stays string, array stays array).
// Without options it falls back to the native color input for back-compat.
function TweakColor({
  label,
  value,
  options,
  onChange
}) {
  if (!options || !options.length) {
    return /*#__PURE__*/React.createElement("div", {
      className: "twk-row twk-row-h"
    }, /*#__PURE__*/React.createElement("div", {
      className: "twk-lbl"
    }, /*#__PURE__*/React.createElement("span", null, label)), /*#__PURE__*/React.createElement("input", {
      type: "color",
      className: "twk-swatch",
      value: value,
      onChange: e => onChange(e.target.value)
    }));
  }
  // Native <input type=color> emits lowercase hex per the HTML spec, so
  // compare case-insensitively. String() guards JSON.stringify(undefined),
  // which returns the primitive undefined (no .toLowerCase).
  const key = o => String(JSON.stringify(o)).toLowerCase();
  const cur = key(value);
  return /*#__PURE__*/React.createElement(TweakRow, {
    label: label
  }, /*#__PURE__*/React.createElement("div", {
    className: "twk-chips",
    role: "radiogroup"
  }, options.map((o, i) => {
    const colors = Array.isArray(o) ? o : [o];
    const [hero, ...rest] = colors;
    const sup = rest.slice(0, 4);
    const on = key(o) === cur;
    return /*#__PURE__*/React.createElement("button", {
      key: i,
      type: "button",
      className: "twk-chip",
      role: "radio",
      "aria-checked": on,
      "data-on": on ? '1' : '0',
      "aria-label": colors.join(', '),
      title: colors.join(' · '),
      style: {
        background: hero
      },
      onClick: () => onChange(o)
    }, sup.length > 0 && /*#__PURE__*/React.createElement("span", null, sup.map((c, j) => /*#__PURE__*/React.createElement("i", {
      key: j,
      style: {
        background: c
      }
    }))), on && /*#__PURE__*/React.createElement(__TwkCheck, {
      light: __twkIsLight(hero)
    }));
  })));
}
function TweakButton({
  label,
  onClick,
  secondary = false
}) {
  return /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: secondary ? 'twk-btn secondary' : 'twk-btn',
    onClick: onClick
  }, label);
}
Object.assign(window, {
  useTweaks,
  TweaksPanel,
  TweakSection,
  TweakRow,
  TweakSlider,
  TweakToggle,
  TweakRadio,
  TweakSelect,
  TweakText,
  TweakNumber,
  TweakColor,
  TweakButton
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/app-v2/tweaks-panel.jsx", error: String((e && e.message) || e) }); }

// ui_kits/app-v2/ui.jsx
try { (() => {
/* Maranki App Redesign v2 — tokens & primitives.
   The v2 vocabulary: ledger rows on paper (hairlines, not card-soup),
   white cards reserved for the flashcard + hero moments, oversized serif,
   tabular mono numerals, fine ink-line data viz. Everything reads CSS vars
   so the whole app re-themes by flipping data-theme on the wrapper. */

const v2v = n => `var(${n})`;
const T = {
  paper: v2v('--paper'),
  paperSunk: v2v('--paper-sunk'),
  surface: v2v('--surface'),
  card: v2v('--card'),
  cardHover: v2v('--card-hover'),
  ink: v2v('--ink'),
  ink2: v2v('--ink-2'),
  ink3: v2v('--ink-3'),
  inkOn: v2v('--ink-on-color'),
  hair: v2v('--hairline'),
  hairStrong: v2v('--hairline-strong'),
  hairSoft: v2v('--hairline-soft'),
  pine: v2v('--pine'),
  pineDeep: v2v('--pine-deep'),
  pineBright: v2v('--pine-bright'),
  pineTint: v2v('--pine-tint'),
  pineTint2: v2v('--pine-tint-2'),
  amber: v2v('--amber'),
  amberDeep: v2v('--amber-deep'),
  amberTint: v2v('--amber-tint'),
  honey: v2v('--honey'),
  success: v2v('--success'),
  successTint: v2v('--success-tint'),
  warning: v2v('--warning'),
  warningTint: v2v('--warning-tint'),
  danger: v2v('--danger'),
  dangerTint: v2v('--danger-tint'),
  info: v2v('--info'),
  infoTint: v2v('--info-tint'),
  rateAgain: v2v('--rate-again'),
  rateHard: v2v('--rate-hard'),
  rateGood: v2v('--rate-good'),
  rateEasy: v2v('--rate-easy'),
  serif: "'Newsreader', Georgia, serif",
  sans: "'Hanken Grotesk', -apple-system, system-ui, sans-serif",
  mono: "'Spline Sans Mono', ui-monospace, monospace",
  shCard: v2v('--shadow-card'),
  shSm: v2v('--shadow-sm'),
  shMd: v2v('--shadow-md'),
  shLg: v2v('--shadow-lg'),
  inverseSurface: v2v('--inverse-surface'),
  inverseText: v2v('--inverse-text'),
  inverseAccent: v2v('--inverse-accent'),
  tabbarBg: v2v('--tabbar-bg'),
  scrim: v2v('--scrim')
};
const CEFR = {
  A1: [v2v('--cefr-a1'), v2v('--cefr-a1-tint')],
  A2: [v2v('--cefr-a2'), v2v('--cefr-a2-tint')],
  B1: [v2v('--cefr-b1'), v2v('--cefr-b1-tint')],
  B2: [v2v('--cefr-b2'), v2v('--cefr-b2-tint')],
  C1: [v2v('--cefr-c1'), v2v('--cefr-c1-tint')],
  C2: [v2v('--cefr-c2'), v2v('--cefr-c2-tint')]
};
const STATE = {
  new: [v2v('--state-new'), v2v('--state-new-tint')],
  learning: [v2v('--state-learning'), v2v('--state-learning-tint')],
  review: [v2v('--state-review'), v2v('--state-review-tint')],
  mastered: [v2v('--state-mastered'), v2v('--state-mastered-tint')],
  due: [v2v('--state-due'), v2v('--state-due-tint')]
};
const STATE_ICON = {
  new: 'sparkles',
  learning: 'school',
  review: 'repeat',
  mastered: 'checkmark-circle',
  due: 'time'
};
const softTint = (token, pct = 12) => `color-mix(in srgb, ${token} ${pct}%, transparent)`;
const TOPPAD = 54; // clears the status bar
const TABH = 80; // bottom tab bar height

function Ion({
  name,
  size = 22,
  color = 'currentColor',
  style = {}
}) {
  return /*#__PURE__*/React.createElement("ion-icon", {
    name: name,
    style: {
      fontSize: size,
      color,
      ...style
    }
  });
}

/* ——— buttons ——— */
function Btn({
  kind = 'primary',
  icon,
  children,
  onClick,
  full,
  size = 'md',
  sub,
  style = {},
  disabled
}) {
  const pad = size === 'lg' ? '15px 26px' : size === 'sm' ? '8px 15px' : '12px 20px';
  const fs = size === 'lg' ? 16.5 : size === 'sm' ? 13.5 : 15;
  const kinds = {
    primary: {
      background: T.pine,
      color: T.inkOn,
      boxShadow: T.shSm
    },
    reward: {
      background: T.amber,
      color: '#fff',
      boxShadow: T.shSm
    },
    secondary: {
      background: T.card,
      color: T.ink,
      border: `1px solid ${T.hairStrong}`
    },
    ghost: {
      background: 'transparent',
      color: T.pine
    },
    quiet: {
      background: T.paperSunk,
      color: T.ink2
    },
    danger: {
      background: T.dangerTint,
      color: T.danger
    },
    dangerSolid: {
      background: T.danger,
      color: '#fff'
    }
  };
  return /*#__PURE__*/React.createElement("button", {
    onClick: disabled ? undefined : onClick,
    onMouseDown: e => {
      if (!disabled) e.currentTarget.style.transform = 'scale(0.97)';
    },
    onMouseUp: e => e.currentTarget.style.transform = 'scale(1)',
    onMouseLeave: e => e.currentTarget.style.transform = 'scale(1)',
    style: {
      display: full ? 'flex' : 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      fontFamily: T.sans,
      fontWeight: 700,
      fontSize: fs,
      border: 'none',
      cursor: disabled ? 'default' : 'pointer',
      borderRadius: 999,
      padding: pad,
      width: full ? '100%' : undefined,
      opacity: disabled ? 0.45 : 1,
      boxSizing: 'border-box',
      transition: 'transform .14s, background .14s, opacity .2s',
      whiteSpace: 'nowrap',
      ...kinds[kind],
      ...style
    }
  }, icon && /*#__PURE__*/React.createElement(Ion, {
    name: icon,
    size: fs + 3
  }), sub ? /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'flex-start',
      lineHeight: 1.2
    }
  }, /*#__PURE__*/React.createElement("span", null, children), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      fontWeight: 600,
      opacity: 0.75
    }
  }, sub)) : children);
}
function IconBtn({
  icon,
  onClick,
  size = 38,
  iconSize,
  color = T.ink2,
  bg = 'transparent',
  border,
  disabled,
  style = {}
}) {
  return /*#__PURE__*/React.createElement("button", {
    onClick: disabled ? undefined : onClick,
    style: {
      width: size,
      height: size,
      borderRadius: 999,
      background: bg,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      border: border ? `1px solid ${T.hairStrong}` : 'none',
      cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? 0.35 : 1,
      flex: 'none',
      transition: 'opacity .2s',
      ...style
    }
  }, /*#__PURE__*/React.createElement(Ion, {
    name: icon,
    size: iconSize || size * 0.55,
    color: color
  }));
}

/* ——— badges & chips ——— */
function LevelBadge({
  level,
  size = 11.5
}) {
  const [fg, bg] = CEFR[level] || CEFR.A1;
  return /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: T.sans,
      fontWeight: 800,
      fontSize: size,
      color: fg,
      background: bg,
      padding: '3px 8px',
      borderRadius: 999,
      letterSpacing: '0.01em',
      flex: 'none'
    }
  }, level);
}
function StateDot({
  state,
  size = 7
}) {
  const [fg] = STATE[state] || STATE.new;
  return /*#__PURE__*/React.createElement("span", {
    title: state,
    style: {
      width: size,
      height: size,
      borderRadius: 999,
      background: fg,
      display: 'inline-block',
      flex: 'none'
    }
  });
}
function StateBadge({
  state,
  label,
  icon
}) {
  const [fg, bg] = STATE[state] || STATE.new;
  return /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5,
      fontFamily: T.sans,
      fontWeight: 700,
      fontSize: 12,
      color: fg,
      background: bg,
      padding: '4px 10px',
      borderRadius: 999,
      flex: 'none'
    }
  }, icon !== false && /*#__PURE__*/React.createElement(Ion, {
    name: icon || STATE_ICON[state],
    size: 13
  }), label);
}
function Chip({
  active,
  icon,
  children,
  onClick,
  dismiss,
  onDismiss
}) {
  return /*#__PURE__*/React.createElement("button", {
    onClick: onClick,
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      fontFamily: T.sans,
      fontWeight: 650,
      fontSize: 13.5,
      cursor: 'pointer',
      padding: '7px 13px',
      borderRadius: 999,
      border: `1px solid ${active ? T.pine : T.hairStrong}`,
      background: active ? T.pine : 'transparent',
      color: active ? '#fff' : T.ink2,
      transition: 'all .14s',
      whiteSpace: 'nowrap',
      flex: 'none'
    }
  }, icon && /*#__PURE__*/React.createElement(Ion, {
    name: icon,
    size: 14
  }), children, dismiss && /*#__PURE__*/React.createElement(Ion, {
    name: "close",
    size: 13,
    style: {
      marginLeft: 2
    },
    onClick: onDismiss
  }));
}
function Pill({
  children,
  fg = T.ink2,
  bg = T.paperSunk,
  mono,
  style = {}
}) {
  return /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: mono ? T.mono : T.sans,
      fontWeight: mono ? 500 : 700,
      fontSize: 12,
      color: fg,
      background: bg,
      padding: '3px 9px',
      borderRadius: 999,
      fontFeatureSettings: "'tnum' 1",
      flex: 'none',
      whiteSpace: 'nowrap',
      ...style
    }
  }, children);
}

/* ——— layout & type ——— */
function Overline({
  children,
  style = {}
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: '0.09em',
      textTransform: 'uppercase',
      color: T.ink3,
      whiteSpace: 'nowrap',
      ...style
    }
  }, children);
}
function SectionHead({
  children,
  action,
  actionLabel,
  onAction,
  style = {}
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      margin: '26px 0 6px',
      ...style
    }
  }, /*#__PURE__*/React.createElement(Overline, null, children), actionLabel && /*#__PURE__*/React.createElement("button", {
    onClick: onAction,
    style: {
      background: 'none',
      border: 'none',
      cursor: 'pointer',
      fontFamily: T.sans,
      fontWeight: 700,
      fontSize: 13,
      color: T.pine,
      display: 'flex',
      alignItems: 'center',
      gap: 4
    }
  }, actionLabel), action);
}

/* ledger row — the v2 list idiom: hairline-separated rows on paper */
function Row({
  children,
  onClick,
  pad = '14px 0',
  last,
  style = {}
}) {
  return /*#__PURE__*/React.createElement("div", {
    onClick: onClick,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      padding: pad,
      borderBottom: last ? 'none' : `1px solid ${T.hairSoft}`,
      cursor: onClick ? 'pointer' : 'default',
      ...style
    }
  }, children);
}
function Card({
  children,
  style = {},
  onClick,
  pad = 16
}) {
  return /*#__PURE__*/React.createElement("div", {
    onClick: onClick,
    style: {
      background: T.card,
      border: `1px solid ${T.hair}`,
      borderRadius: 16,
      boxShadow: T.shSm,
      padding: pad,
      boxSizing: 'border-box',
      cursor: onClick ? 'pointer' : 'default',
      ...style
    }
  }, children);
}

/* ——— data viz: fine ink lines ——— */
function Bar({
  value,
  color = T.pine,
  track = T.paperSunk,
  h = 4
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      height: h,
      background: track,
      borderRadius: 999,
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: `${Math.min(100, value)}%`,
      height: '100%',
      background: color,
      borderRadius: 999,
      transition: 'width .5s cubic-bezier(0.22,1,0.36,1)'
    }
  }));
}
function SegBar({
  mastered = 0,
  learning = 0,
  neww = 0,
  total,
  h = 4
}) {
  const t = total || mastered + learning + neww || 1;
  const pct = n => n / t * 100;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      height: h,
      background: T.paperSunk,
      borderRadius: 999,
      overflow: 'hidden',
      gap: 1
    }
  }, mastered > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      width: `${pct(mastered)}%`,
      background: T.pine
    }
  }), learning > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      width: `${pct(learning)}%`,
      background: T.amber
    }
  }), neww > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      width: `${pct(neww)}%`,
      background: T.info,
      opacity: 0.55
    }
  }));
}
function Ring({
  value,
  size = 64,
  stroke = 5,
  color = T.pine,
  track = T.paperSunk,
  children
}) {
  const r = (size - stroke) / 2,
    c = 2 * Math.PI * r;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative',
      width: size,
      height: size,
      flex: 'none'
    }
  }, /*#__PURE__*/React.createElement("svg", {
    width: size,
    height: size,
    style: {
      transform: 'rotate(-90deg)'
    }
  }, /*#__PURE__*/React.createElement("circle", {
    cx: size / 2,
    cy: size / 2,
    r: r,
    fill: "none",
    stroke: track,
    strokeWidth: stroke
  }), /*#__PURE__*/React.createElement("circle", {
    cx: size / 2,
    cy: size / 2,
    r: r,
    fill: "none",
    stroke: color,
    strokeWidth: stroke,
    strokeDasharray: c,
    strokeDashoffset: c * (1 - Math.min(1, value / 100)),
    strokeLinecap: "round",
    style: {
      transition: 'stroke-dashoffset .6s cubic-bezier(0.22,1,0.36,1)'
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      inset: 0,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }
  }, children));
}

/* ——— controls ——— */
function SegCtrl({
  options,
  value,
  onChange,
  size = 'md'
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      background: T.paperSunk,
      borderRadius: 999,
      padding: 3
    }
  }, options.map(o => {
    const on = value === (o.id ?? o);
    return /*#__PURE__*/React.createElement("button", {
      key: o.id ?? o,
      onClick: () => onChange(o.id ?? o),
      style: {
        flex: 1,
        padding: size === 'sm' ? '6px 10px' : '8px 12px',
        borderRadius: 999,
        border: 'none',
        cursor: 'pointer',
        background: on ? T.card : 'transparent',
        boxShadow: on ? T.shSm : 'none',
        fontFamily: T.sans,
        fontWeight: 700,
        fontSize: size === 'sm' ? 12.5 : 13.5,
        color: on ? T.ink : T.ink3,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 5,
        transition: 'all .18s'
      }
    }, o.icon && /*#__PURE__*/React.createElement(Ion, {
      name: o.icon,
      size: 14
    }), o.label ?? o);
  }));
}
function Toggle({
  on,
  onChange
}) {
  return /*#__PURE__*/React.createElement("button", {
    onClick: () => onChange(!on),
    style: {
      width: 46,
      height: 28,
      borderRadius: 999,
      border: 'none',
      cursor: 'pointer',
      flex: 'none',
      background: on ? T.pine : T.hairStrong,
      position: 'relative',
      transition: 'background .2s'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      position: 'absolute',
      top: 3,
      left: on ? 21 : 3,
      width: 22,
      height: 22,
      borderRadius: 999,
      background: '#fff',
      boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
      transition: 'left .2s cubic-bezier(0.22,1,0.36,1)'
    }
  }));
}
function Stepper({
  value,
  onChange,
  min = 0,
  max = 999,
  step = 1,
  fmt
}) {
  const btn = (icon, d, dis) => /*#__PURE__*/React.createElement("button", {
    onClick: () => !dis && onChange(value + d),
    style: {
      width: 30,
      height: 30,
      borderRadius: 999,
      border: `1px solid ${T.hairStrong}`,
      background: T.card,
      cursor: dis ? 'default' : 'pointer',
      opacity: dis ? 0.35 : 1,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flex: 'none'
    }
  }, /*#__PURE__*/React.createElement(Ion, {
    name: icon,
    size: 15,
    color: T.ink2
  }));
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10
    }
  }, btn('remove', -step, value <= min), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: T.mono,
      fontSize: 14.5,
      fontWeight: 500,
      color: T.ink,
      minWidth: 34,
      textAlign: 'center',
      fontFeatureSettings: "'tnum' 1"
    }
  }, fmt ? fmt(value) : value), btn('add', step, value >= max));
}
function Field({
  label,
  value,
  onChange,
  placeholder,
  mono,
  multiline,
  autoFocus,
  hint
}) {
  const Comp = multiline ? 'textarea' : 'input';
  return /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 16
    }
  }, /*#__PURE__*/React.createElement(Overline, {
    style: {
      marginBottom: 7
    }
  }, label), /*#__PURE__*/React.createElement(Comp, {
    value: value,
    autoFocus: autoFocus,
    placeholder: placeholder,
    onChange: e => onChange(e.target.value),
    rows: multiline ? 2 : undefined,
    style: {
      width: '100%',
      boxSizing: 'border-box',
      background: T.card,
      border: `1px solid ${T.hairStrong}`,
      borderRadius: 12,
      padding: '12px 14px',
      fontFamily: mono ? T.mono : T.sans,
      fontSize: 15.5,
      color: T.ink,
      resize: 'none',
      lineHeight: 1.45
    }
  }), hint && /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontSize: 12,
      color: T.ink3,
      marginTop: 5
    }
  }, hint));
}

/* ——— habit ——— */
function StreakChip({
  days,
  freezes = 0,
  onClick
}) {
  return /*#__PURE__*/React.createElement("button", {
    onClick: onClick,
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      background: T.amberTint,
      border: 'none',
      padding: '7px 12px 7px 10px',
      borderRadius: 999,
      cursor: 'pointer',
      flex: 'none'
    }
  }, /*#__PURE__*/React.createElement(Ion, {
    name: "flame",
    size: 17,
    color: T.amber
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: T.sans,
      fontWeight: 800,
      fontSize: 14.5,
      color: T.amberDeep,
      fontFeatureSettings: "'tnum' 1"
    }
  }, days), freezes > 0 && /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 2,
      marginLeft: 2
    }
  }, /*#__PURE__*/React.createElement(Ion, {
    name: "snow",
    size: 13,
    color: T.info
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: T.sans,
      fontWeight: 700,
      fontSize: 12,
      color: T.info
    }
  }, freezes)));
}

/* ——— shell ——— */
function TabBar({
  active,
  onChange,
  studyDue = 0
}) {
  const tabs = [{
    id: 'home',
    icon: 'home',
    label: 'Home'
  }, {
    id: 'study',
    icon: 'book',
    label: 'Study',
    badge: studyDue
  }, {
    id: 'browse',
    icon: 'search',
    label: 'Library'
  }, {
    id: 'stats',
    icon: 'bar-chart',
    label: 'Progress'
  }, {
    id: 'settings',
    icon: 'settings',
    label: 'Settings'
  }];
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
      height: TABH,
      background: T.tabbarBg,
      backdropFilter: 'blur(16px)',
      WebkitBackdropFilter: 'blur(16px)',
      borderTop: `1px solid ${T.hair}`,
      display: 'flex',
      alignItems: 'flex-start',
      paddingTop: 9,
      zIndex: 40
    }
  }, tabs.map(t => {
    const on = active === t.id;
    return /*#__PURE__*/React.createElement("button", {
      key: t.id,
      onClick: () => onChange(t.id),
      style: {
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 3,
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        position: 'relative'
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        position: 'relative'
      }
    }, /*#__PURE__*/React.createElement(Ion, {
      name: on ? t.icon : `${t.icon}-outline`,
      size: 23,
      color: on ? T.pine : T.ink3
    }), t.badge > 0 && /*#__PURE__*/React.createElement("span", {
      style: {
        position: 'absolute',
        top: -4,
        right: -11,
        minWidth: 16,
        height: 16,
        padding: '0 4px',
        boxSizing: 'border-box',
        background: T.danger,
        color: '#fff',
        borderRadius: 999,
        fontFamily: T.sans,
        fontWeight: 800,
        fontSize: 10,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: `1.5px solid ${T.surface}`
      }
    }, t.badge > 99 ? '99+' : t.badge)), /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: T.sans,
        fontSize: 10.5,
        fontWeight: on ? 750 : 500,
        color: on ? T.pine : T.ink3
      }
    }, t.label));
  }));
}
function Snackbar({
  text,
  onUndo,
  actionLabel = 'Undo'
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      left: 16,
      right: 16,
      bottom: TABH + 12,
      zIndex: 70,
      background: T.inverseSurface,
      color: T.inverseText,
      borderRadius: 12,
      padding: '12px 14px 12px 16px',
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      boxShadow: T.shLg,
      fontFamily: T.sans,
      fontSize: 13.5,
      animation: 'snackIn .24s cubic-bezier(0.22,1,0.36,1)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1
    }
  }, text), onUndo && /*#__PURE__*/React.createElement("button", {
    onClick: onUndo,
    style: {
      background: 'none',
      border: 'none',
      color: T.inverseAccent,
      fontFamily: T.sans,
      fontWeight: 800,
      fontSize: 13.5,
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      gap: 5,
      flex: 'none'
    }
  }, /*#__PURE__*/React.createElement(Ion, {
    name: "arrow-undo",
    size: 14
  }), actionLabel));
}
function Sheet({
  open,
  onClose,
  children,
  title,
  maxH = '78%'
}) {
  if (!open) return null;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      inset: 0,
      zIndex: 60
    }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: onClose,
    style: {
      position: 'absolute',
      inset: 0,
      background: T.scrim,
      animation: 'fadeIn .2s'
    }
  }), /*#__PURE__*/React.createElement("div", {
    className: "mk-scroll",
    style: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      background: T.surface,
      borderRadius: '24px 24px 0 0',
      padding: '10px 20px 34px',
      boxShadow: T.shLg,
      animation: 'sheetUp .28s cubic-bezier(0.22,1,0.36,1)',
      maxHeight: maxH,
      overflowY: 'auto',
      boxSizing: 'border-box'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 36,
      height: 4,
      background: T.hairStrong,
      borderRadius: 999,
      margin: '0 auto 14px'
    }
  }), title && /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.serif,
      fontSize: 22,
      fontWeight: 600,
      color: T.ink,
      marginBottom: 12
    }
  }, title), children));
}

/* full-screen stack header (editors, import, session) */
function StackBar({
  title,
  onBack,
  backIcon = 'chevron-back',
  right,
  sub
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: `${TOPPAD}px 14px 10px`,
      borderBottom: `1px solid ${T.hairSoft}`
    }
  }, /*#__PURE__*/React.createElement(IconBtn, {
    icon: backIcon,
    onClick: onBack,
    size: 36,
    iconSize: 21,
    color: T.ink
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontWeight: 750,
      fontSize: 16.5,
      color: T.ink,
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis'
    }
  }, title), sub && /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontSize: 12,
      color: T.ink3
    }
  }, sub)), right);
}

/* screen header (tabs): overline date/context + big serif title + actions */
function ScreenHead({
  overline,
  title,
  sub,
  right,
  style = {}
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: `${TOPPAD + 6}px 0 4px`,
      ...style
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      gap: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      minWidth: 0
    }
  }, overline && /*#__PURE__*/React.createElement(Overline, {
    style: {
      marginBottom: 6
    }
  }, overline), /*#__PURE__*/React.createElement("h1", {
    style: {
      margin: 0,
      fontFamily: T.serif,
      fontWeight: 600,
      fontSize: 32,
      lineHeight: 1.1,
      letterSpacing: '-0.02em',
      color: T.ink
    }
  }, title), sub && /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontSize: 14.5,
      color: T.ink2,
      marginTop: 6,
      whiteSpace: 'nowrap'
    }
  }, sub)), right && /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      alignItems: 'center',
      flex: 'none',
      paddingTop: 2
    }
  }, right)));
}

/* scrolling page body inside the device */
function Page({
  children,
  pad = 20,
  bottom = TABH + 24,
  style = {}
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: "mk-scroll",
    style: {
      position: 'absolute',
      inset: 0,
      overflowY: 'auto',
      padding: `0 ${pad}px ${bottom}px`,
      boxSizing: 'border-box',
      background: T.paper,
      ...style
    }
  }, children);
}
function FAB({
  onClick,
  icon = 'add'
}) {
  return /*#__PURE__*/React.createElement("button", {
    onClick: onClick,
    style: {
      position: 'absolute',
      right: 18,
      bottom: TABH + 18,
      width: 54,
      height: 54,
      borderRadius: 999,
      background: T.pine,
      border: 'none',
      boxShadow: T.shMd,
      cursor: 'pointer',
      zIndex: 45,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }
  }, /*#__PURE__*/React.createElement(Ion, {
    name: icon,
    size: 26,
    color: "#fff"
  }));
}

/* settings-style list row */
function ListRow({
  icon,
  iconColor = T.pine,
  iconBg = T.pineTint,
  title,
  sub,
  right,
  onClick,
  last,
  danger
}) {
  return /*#__PURE__*/React.createElement(Row, {
    onClick: onClick,
    last: last,
    pad: "13px 0"
  }, icon && /*#__PURE__*/React.createElement("div", {
    style: {
      width: 34,
      height: 34,
      borderRadius: 10,
      background: danger ? T.dangerTint : iconBg,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flex: 'none'
    }
  }, /*#__PURE__*/React.createElement(Ion, {
    name: icon,
    size: 17,
    color: danger ? T.danger : iconColor
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontWeight: 650,
      fontSize: 15,
      color: danger ? T.danger : T.ink
    }
  }, title), sub && /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: T.sans,
      fontSize: 12.5,
      color: T.ink3,
      marginTop: 1,
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis'
    }
  }, sub)), right ?? /*#__PURE__*/React.createElement(Ion, {
    name: "chevron-forward",
    size: 16,
    color: T.ink3
  }));
}

/* deck identity square (flag) */
function FlagSq({
  flag,
  size = 38
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      width: size,
      height: size,
      borderRadius: 10,
      background: T.paperSunk,
      border: `1px solid ${T.hairSoft}`,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: size * 0.5,
      flex: 'none'
    }
  }, flag);
}
Object.assign(window, {
  T,
  CEFR,
  STATE,
  STATE_ICON,
  TOPPAD,
  TABH,
  softTint,
  Ion,
  Btn,
  IconBtn,
  LevelBadge,
  StateDot,
  StateBadge,
  Chip,
  Pill,
  Overline,
  SectionHead,
  Row,
  Card,
  Bar,
  SegBar,
  Ring,
  SegCtrl,
  Toggle,
  Stepper,
  Field,
  StreakChip,
  TabBar,
  Snackbar,
  Sheet,
  StackBar,
  ScreenHead,
  Page,
  FAB,
  ListRow,
  FlagSq
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/app-v2/ui.jsx", error: String((e && e.message) || e) }); }

})();
