# Maranki — Design System

A complete brand & UI design system for **Maranki**, a spaced-repetition vocabulary-learning app. This system gives design agents everything needed to produce well-branded Maranki interfaces, mockups, slides, and prototypes — typography, color, spacing, iconography, real UI-kit components, and tone-of-voice rules.

> **This is a ground-up visual redesign.** The source app shipped a dark, neon **purple→pink glassmorphic** look with platform-default fonts. The redesign brief (`maranki-redesign-plan.md`) explicitly scopes *function and behavior* but hands the **entire visual layer** over to be reinvented — "Claude design owns the how-it-looks." This system therefore replaces the old aesthetic entirely with a warm, editorial **paper-and-ink** identity. See **VISUAL FOUNDATIONS** for the rationale.

---

## 1. Product context

**Maranki** is a mobile-first (iOS / Android / web, built in React Native + Expo) **vocabulary-learning app built on spaced repetition.** A learner studies decks of word cards; an SM-2-based algorithm schedules each card to resurface just before it would be forgotten. The app tracks progress, streaks, and mastery, and offers analytics, custom collections, multiple study modes, and import of external (Anki) decks.

**Who it's for:** language learners (built-in content is **German** and **Spanish**, CEFR A1–C2), from guided beginners to power users who tune the SRS algorithm and import their own `.apkg`/CSV decks.

**The core daily loop:** open app → see what's ready → review due cards one at a time → rate recall on a **4-button scale (Again / Hard / Good / Easy)** → keep the streak alive.

**Primary navigation — 5 bottom tabs:** Home (dashboard) · Study (pick & launch sessions) · Browse (the vocabulary library) · Stats (analytics) · Settings.

### Domain vocabulary (worth knowing when designing)
- **Card** — one vocabulary item: `word` + `translation` + optional `example`, `pronunciation` (IPA), `level` (CEFR A1–C2), `type` (part of speech), tags.
- **Deck** — a collection of cards (usually one language). Built-in or imported.
- **Collection** — a saved *smart filter* over all cards (a live query, not a folder).
- **Card states** — **New → Learning → Review (graduated) → Mastered** (interval ≥ 21 days). "Due" = ready for review now.
- **Streak** — consecutive calendar days with at least one completed session. A **streak freeze** bridges one missed day.
- **SRS** — SuperMemo-2 variant with an Anki-style learning-steps phase.

### What the redesign is really about
Per the plan, Maranki is "~80% built and stalled one wire short of shipping." The dominant design move is **surface, sequence, and unify** existing-but-hidden capability: an undo/snackbar system, a gamification/XP engine, pronunciation practice, and ~11 stat widgets are all coded but mounted nowhere. The redesign turns dead-end states into "keep going" momentum, makes every number trustworthy, pays out the habit loop, and gives content a discoverable home. Mockups in this system reflect that intent.

---

## 2. Sources

This system was reverse-engineered from materials the user provided. You do **not** need access to these to use the system, but they're recorded for anyone who wants to go deeper:

| Source | What it is | Where |
|---|---|---|
| **`omrylmz/maranki`** (private GitHub repo) | The full React Native (Expo) codebase — data model, SM-2 engine, the original theme/token/icon system, German + Spanish vocab seed data. | `github.com/omrylmz/maranki` |
| **`redesign/maranki-functional-spec.md`** | Reverse-engineered functional & behavioral spec (956 lines) — every screen, state, and rule. Visual-agnostic by design. | provided codebase (`redesign/`) |
| **`redesign/maranki-redesign-plan.md`** | Prioritized redesign roadmap (427 lines) — what to mock, grouped by surface. | provided codebase (`redesign/`) |

**Want a higher-fidelity build?** Explore the `omrylmz/maranki` repository directly — `src/constants/` (theme/tokens/icons), `src/utils/sm2.ts` (the scheduling engine), `src/utils/levelStyles.ts` (CEFR & type colors), and `src/data/` (the real German/Spanish card corpus) are the ground-truth references behind this system.

### Provenance of the visuals
- **Fonts:** the original app used **no custom fonts** (React Native platform defaults). The Newsreader + Hanken Grotesk + Spline Sans Mono pairing here is a **redesign choice**, loaded from Google Fonts. ⚑ *See "Font substitution" under VISUAL FOUNDATIONS.*
- **Colors:** the original token palette (neon purple/pink on near-black) was **deliberately not carried over.** Only the *structure* of the token system (semantic roles: surface/text/interactive/feedback/CEFR/card-state) was preserved; every value is new.
- **Icons:** the app uses **Ionicons** (`@expo/vector-icons`). This system keeps that exact icon vocabulary via the Ionicons CDN web component. See ICONOGRAPHY.
- **Logo / app icon:** the repo's app icon is a generic AI-generated neon "M". It was **not reused.** Maranki's mark here is a **typographic wordmark** (see `assets/`).

---

## 3. Index — what's in this folder

```
README.md                  ← you are here (context, tone, visual + icon foundations, manifest)
SKILL.md                   ← Agent-Skill front-matter so this can be dropped into Claude Code
colors_and_type.css        ← all CSS variables (color, type, spacing, radius, shadow, motion) + semantic type classes
ion-inline.js              ← reliable Ionicons renderer (inlines the official SVGs; include + use <ion-icon>)
assets/                    ← logo / wordmark, brand marks
fonts/                     ← (note) fonts are Google-Fonts-loaded; see VISUAL FOUNDATIONS
preview/                   ← Design-System-tab cards (swatches, type specimens, components)
ui_kits/
  app-v2/                  ← the Maranki mobile app UI kit (index.html + JSX components)
```

- **Start a mockup:** link `colors_and_type.css`, pull components from `ui_kits/app-v2/`, and follow the tone rules below.
- **Browse the system visually:** the cards in `preview/` populate the Design System tab.
- **Build the real app surfaces:** open `ui_kits/app-v2/index.html` for an interactive click-through of the redesigned core screens.

---

## 4. CONTENT FUNDAMENTALS — how Maranki writes

Maranki's voice is a **warm, encouraging study companion** — never a stern teacher, never a hype-machine. It respects the learner's effort and time. Copy is the connective tissue of the habit loop, so it leans motivational without being saccharine.

**Person & address.** Speak to the learner as **"you"**; the app refers to itself rarely and never as "I". Greetings are personal and time-aware: *"Good morning"* / *"Good evening"* / *"Welcome to Maranki!"* for brand-new users.

**Tone & vibe.** Calm, confident, quietly celebratory. The app cheers genuine effort ("**Daily goal complete!** More tomorrow.") and reassures on misses ("All caught up — come back tomorrow."). When a streak is saved by a freeze, it's *reassuring*, not alarming: *"Your 12-day streak was saved — 1 freeze used, 2 left."* Momentum language is core: *"Keep going,"* *"Study ahead,"* *"Review hardest."*

**Casing.** **Sentence case** everywhere — headings, buttons, labels (*"Start review,"* *"Your progress,"* not Title Case). The only uppercase is the **tracked overline / eyebrow** used sparingly for section labels (e.g. `TODAY`, `YOUR DECKS`). CEFR levels are uppercase by convention (A1, B2, C2).

**Numbers are concrete and honest.** Always pair a number with its meaning: *"18 due, 5 new, 3 learning,"* *"68% mastered,"* *"~3 min."* Intervals are compact and human: **soon · 10m · 1d · 6d · 2mo.** Never show a raw count where a limit-aware "ready" count is meant — the redesign's whole thesis is *trustworthy numbers*.

**Encouragement, tiered by performance.** Session-complete copy scales with accuracy — a great session gets an enthusiastic line, a rough one gets a kind, forward-looking one ("Lots of lapses — these will come back soon."). Never shame.

**Buttons are verbs.** *"Start review," "Study ahead," "Review these 12," "Add card," "Keep editing," "Discard changes."* Destructive actions name what's lost ("Delete deck and its 240 cards").

**Empty states always offer a way forward.** Distinguish *causes*: "Your library is empty → Add a card / Import a deck" vs. "No matches → Clear filters." Never a dead end.

**Emoji.** **Not used in UI copy.** The brand expresses warmth through type, color, and the Ionicons glyph set (flame for streaks, trophy for achievements) — not emoji. The one exception inherited from the data layer: **language flag emoji** (🇩🇪 🇪🇸) used purely as compact deck identifiers; prefer the dedicated flag chip component where possible.

**Specific examples**
- Greeting + subtitle: *"Good evening." / "18 cards ready to study."*
- Goal met: *"Daily goal complete! More tomorrow."*
- All caught up: *"You're all caught up. Come back tomorrow — or study ahead."*
- Streak saved: *"Streak saved! We used 1 freeze to protect your 12-day streak. 2 left."*
- Rating preview: each button shows its outcome — `Again · soon`, `Hard · 4d`, `Good · 9d`, `Easy · 21d`.
- Coaching line: *"Strong recall today — your retention is climbing."*

---

## 5. VISUAL FOUNDATIONS

The redesign's organizing metaphor is **the index card and the printed page**: a vocabulary app is fundamentally about *words*, so the system treats type as the hero and frames everything on warm, tactile paper. The result is calm, literary, and focused — the opposite of the original's neon-glass nightclub feel.

### Color vibe
- **Warm paper neutrals.** Backgrounds are a parchment off-white (`--paper #F4F0E7`), surfaces step up to `--surface` and pure-white `--card`. Nothing is cold gray; every neutral carries a faint warm cast. Ink text is a warm near-black (`--ink #211E1A`), never pure `#000`.
- **One calm brand color: deep pine-teal** (`--pine #136F63`) — reads as focus, growth, and quiet confidence. It drives primary actions, the active tab, mastery, and selection.
- **One warm reward color: honey-amber** (`--amber #DD8A2B`, bright `--honey #F2B741`) — reserved for the *habit loop*: streaks, XP, the flame, celebration. Using it sparingly keeps it meaningful.
- **Imagery** (when present — card images): treated warm and natural; no heavy duotone or neon grading. Photography is incidental (user/Anki card images), not a brand pillar.

### Type
- **Newsreader** (serif) — the **vocabulary word**, display headings, and **example sentences** (set in *italic*, as if quoted from real language). Editorial, warm, excellent diacritic coverage for German umlauts and Spanish accents.
- **Hanken Grotesk** (grotesque sans) — all UI: labels, body, buttons, stats. Friendly, highly legible, with strong tabular figures for counts and percentages.
- **Spline Sans Mono** — IPA pronunciation (`/ˈʃtʊndə/`), interval tokens (`1d`, `10m`, `2mo`), and codes.
- **Scale:** modular ratio **1.25** (preserved from the original token system), 16px base. Hero numbers (streak, mastery %) use 800-weight tabular sans; the studied word uses 48px serif.
- ⚑ **Font substitution flag:** the original app had **no brand fonts** to carry over, so these three are a redesign decision loaded via **Google Fonts CDN**. If you need fully offline / self-hosted assets, drop the matching woff2 files into `fonts/` and swap the `@import` in `colors_and_type.css` for `@font-face` rules. **If the user has a preferred typeface, tell me and I'll swap it in.**

### Spacing & layout
- **4px base scale** (`--sp-1` … `--sp-16`). Generous breathing room — this is a focus app, density is low by intention.
- Mobile-first single column with a **persistent 5-tab bottom bar** that clears the device safe area. Stack screens (session, editors, import) push full-screen over the tabs.
- Touch targets ≥ 44px; primary/critical actions are larger. Text never below ~13px in UI; the studied word is large and centered.

### Backgrounds & texture
- **Flat warm paper** — no gradients as decoration, no glassmorphism, no blur-behind. The richness comes from the paper tone + soft shadows, not effects.
- A subtle **paper grain** *may* be applied at very low opacity on large empty surfaces (optional, decorative only) — never on text-bearing cards.
- Color is applied as **solid fills or soft tints** (`--*-tint` tokens), e.g. a selected chip gets `--pine-tint`, a "due" badge gets `--state-due-tint`. Tints are how the system signals state without shouting.

### Cards & elevation
- Cards are **white (`--card`) on paper**, radius **`--r-md` (14px)**, a **1px `--hairline` border**, and a **soft, warm low-contrast shadow** (`--shadow-sm`/`--shadow-md`). The signature flashcard uses `--shadow-card` for a gentle lift.
- No hard black drop shadows; shadows are tinted brown-warm (`rgba(50,40,25,…)`) so they sit naturally on parchment.
- Corner radii: pills (`--r-pill`) for chips/badges/tab indicators; `--r-md` for cards; `--r-lg`/`--r-xl` for modals, sheets, and the flashcard.

### Borders, dividers, capsules
- Hairlines are warm (`--hairline #E4DDCD`), used for card outlines and list dividers. Emphasis borders use `--hairline-strong`.
- **Capsules over protection-gradients:** overlapping text on imagery uses a solid/tinted capsule, not a fade gradient.
- Filter chips, badges, and the tab indicator are **pill-shaped capsules**; selected = filled tint or solid pine, unselected = hairline outline.

### Motion
- **Calm and physical.** Standard transitions use `--ease-out` at `--dur-normal (240ms)`. Reward and the card flip use a gentle spring (`--ease-spring`) — a small overshoot, never a cartoon bounce.
- **Fades + short translates** for entrances (8–12px rise). The flashcard reveal is a quick flip/cross-fade. The "Start review" command may have a soft, slow breathing pulse to signal readiness.
- **Reduced motion is first-class:** when the OS requests it, transitions become instant, pulses/confetti are skipped. Motion is decorative, never the sole carrier of meaning.

### Hover, press & focus states
- **Hover:** surfaces lift slightly (`--card` → `--card-hover`) and/or shadow deepens one step; solid buttons darken toward `--pine-deep` / `--amber-deep`.
- **Press:** a subtle **scale-down to ~0.97** plus the darker fill — tactile, like pressing a real card. No color inversion.
- **Focus:** a visible **2px ring in `--pine`** (offset 2px) on keyboard/switch focus — never removed. State (due, correct/incorrect, level) is always distinguishable by **icon + label + shape**, not color alone (color-blind safe).

### Transparency & blur
- Used **only** for the modal/sheet **scrim** (`rgba(33,30,26,0.45)` over content). No frosted-glass panels, no translucent cards — opacity is for overlays, not decoration.

### Theming — light paper & evening mode
- The system ships **two themes**, both defined as token scopes in `colors_and_type.css`: the default **light "paper"** theme (`:root`) and a warm **"evening"** dark theme (`[data-theme="dark"]`). Flip themes by setting `data-theme="dark"` on any wrapping element (or `<html>`); every component that reads the CSS vars re-themes automatically.
- Evening mode is deliberately **not** a neon flip of the original app: surfaces are **warm espresso** (never pure black), and pine + amber are *brightened* so the brand still glows at night — fitting for an app people use in bed. Shadows switch from warm-brown to neutral-dark, and tints become deep washes.
- **Semantic roles stay stable across themes** — a "mastered" card is pine in both, a "due" badge is red in both, CEFR A1→C2 keeps its spectrum — so meaning never shifts when the lights go down. The UI kit (`ui_kits/app-v2/`) wires a live Light / Evening / System control in Settings and a quick moon/sun toggle on Home.

---

## 6. ICONOGRAPHY

**System: Ionicons** — the exact icon library the Maranki codebase uses (`@expo/vector-icons` → Ionicons). This system preserves that vocabulary for fidelity rather than substituting a different set.

- **How to use:** load the Ionicons web component from CDN and use `<ion-icon name="…">`. It is **not** an emoji or unicode approach — these are crisp vector glyphs that inherit `color` and `font-size`.
  ```html
  <script type="module" src="https://cdn.jsdelivr.net/npm/ionicons@7.4.0/dist/ionicons/ionicons.esm.js"></script>
  <script nomodule src="https://cdn.jsdelivr.net/npm/ionicons@7.4.0/dist/ionicons/ionicons.js"></script>
  <ion-icon name="flame" style="color: var(--amber); font-size: 24px;"></ion-icon>
  ```
- **Outline vs filled.** Inactive/default states use the **`-outline`** variant; active/selected states use the **filled** variant. This is the app's convention for tab bars and toggles (e.g. `home-outline` → `home`, `heart-outline` → `heart`).
- **Sizes** map to the app's scale: 16 (inline/badge), 20 (button/input), 24 (default/nav), 28 (header), 32 (feature), 48 (empty state), 64+ (hero/celebration).
- **The canonical glyphs** (from `src/constants/icons.ts`):
  - **Tabs:** `home` · `book` (Study) · `search` (Browse) · `bar-chart` (Stats) · `settings`
  - **SRS rating buttons:** Again = `refresh`, Hard = `arrow-down`, Good = `checkmark`, Easy = `flash`
  - **Card status:** learned = `checkmark-circle`, learning = `school`, favorite = `heart`, frozen = `snow`, flagged = `flag`
  - **Habit / reward:** streak = `flame`, achievement = `trophy`, XP/easy = `flash`, milestone = `star`
  - **Study:** cards = `albums`, play = `play`, audio = `volume-high`, pronunciation = `mic`, timer = `timer`, hint = `bulb`
  - **Actions:** add = `add`, edit = `pencil`, delete = `trash`, import = `cloud-download`, export = `cloud-upload`, more = `ellipsis-horizontal`, filter = `filter`, shuffle = `shuffle`
  - **Status/feedback:** success = `checkmark-circle`, warning = `warning-outline`, error = `alert-circle`, info = `information-circle-outline`
- **Emoji & unicode.** Emoji are **not** used as UI iconography. The one inherited exception is **language flag emoji** (🇩🇪 🇪🇸 🇫🇷) used as compact deck identifiers; treat them as data, not as the icon system. Everything else is Ionicons.
- ⚑ **Substitution note:** Ionicons is loaded from CDN (no icon font files live in the repo to copy). If a fully offline bundle is needed, vendor the Ionicons package into `assets/icons/`. No substitution of a *different* icon family was made — the set is the product's real one.

---

*Built as a reusable design system. The cards in `preview/` and the components in `ui_kits/app-v2/` are the canonical, copy-pasteable expressions of everything above.*
