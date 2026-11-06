# Maranki

**Maranki is a private, offline flashcard app for anything you want to remember.**
It is a React Native + Expo (SDK 56) app for Android (and iOS for development).

- **One app for any deck.** Bring a deck from Anki (`.apkg` file or AnkiWeb), from a
  spreadsheet (`.csv`), or type your own cards. Nothing is tied to one language or
  topic. A build variant can add a starter pack (the German variant, see below)
  without a second app.
- **Lossless Anki import.** Maranki keeps every field, both directions (reverse
  cards), the subdeck path (as a *Section*), tags, the Anki note id (`guid`, so a
  re-import updates instead of duplicating), your Anki progress and the images.
- **Filters come from your data.** Maranki finds the filter groups that your cards
  already have — for example *Level*, *Type*, *Category*, *Section* and the *Tag*
  tree — and shows a group only when the data in view has it. One filter language
  drives the Library chips, saved Lists, every "Study N" number and every session,
  so **the number on a Study button is always exactly the session it opens**.
- **Not started and Known are real states.** A new deck can wait outside your study
  queue (*Not started*) until you choose what to learn. Cards you already know can
  be marked *Known*: they are not studied, and a few come back once for a quick
  *Check*.
- **Four tabs, one place per job.** **Today** (do today's studying), **Library**
  (find, filter, choose and manage cards), **Progress** (see how you are doing — no
  Study buttons there), **Settings**. Each deck has a **deck page** (the hub: study,
  browse, add cards, choose what to learn, deck settings).

Every word the app uses (Deck, Section, Card, Direction, Not started, Known, Ready,
Practice …) has exactly one meaning. The glossary is in code
(`src/content/glossary.ts`); the in-app Help screen reads it.

## Run it

```bash
npm install
npm start               # Metro (the JavaScript server), generic app
npm run android         # build and install a development build on an emulator or phone
```

The app uses native modules (SQLite, notifications, haptics, file picker, sharing),
so run it as a **development build** (`npm run android` = `expo run:android`), not in
Expo Go. On the web (`npm run web`) it is a **preview only**: nothing is saved, and a
banner says so.

### The first run is empty

A new install starts with **an empty library** — no sample decks, no fake history.
The onboarding asks how much time a day you want to study and offers a daily
reminder (off until you turn it on). Then it ends in a real action: **Import a
deck**, **Find a deck on AnkiWeb** or **Make my own deck** (the German variant adds
**Start with German** on top), or "I'll do this later". The empty Today screen
("Start with a deck") offers the same actions: **Import a file** · **Find on
AnkiWeb** · **Make my own deck**.

### Build variants (the German app)

One codebase builds two apps. The variant is chosen at build time with
`APP_VARIANT`:

| Variant | App name | Android package | What it adds |
|---|---|---|---|
| `generic` (default) | Maranki | `com.omrylmz.maranki` | nothing: the plain app |
| `german` | Maranki German | `com.omrylmz.marankide` | a content pack: 3 bundled German decks (starter decks), card-type presets (field roles and read-aloud languages), deck defaults, German level names, onboarding copy |

```bash
# The decks are private: copy them into assets/packs/german/ first (RELEASING.md).
npm run start:german    # Metro for the German variant (APP_VARIANT=german)
npm run android:german  # build and install the German variant
```

How it works: `app.config.ts` reads `APP_VARIANT` (name, package id, icon), and
`metro.config.js` maps the module `@variant/pack` to
`src/variants/<variant>/pack.ts`. Only the chosen pack (and the `.apkg` files it
needs) goes into the bundle, so the generic app ships no German decks. TypeScript and
jest always see the generic pack.

**When you switch variants, do two things:**

1. Stop Metro and start it again with a clear cache
   (`APP_VARIANT=german npx expo start --clear`), or Metro serves the old pack.
2. Make the native `android/` folder again for the new variant, because the
   package id (`com.omrylmz.maranki` or `com.omrylmz.marankide`) is written into it:

   ```bash
   APP_VARIANT=german npx expo prebuild -p android --clean    # or APP_VARIANT=generic
   ```

   `npm run android` and `npm run android:german` run this step for you when
   `android/` was made for the other variant.

The German variant is the in-place upgrade of the old German fork app (same package
id). **It must be signed with the same key as the installed fork build**, or Android
refuses the update and the only way out deletes the learner's data. Read
[`RELEASING.md`](RELEASING.md) before you build a release.

## Search

Type in the Library search box. Every token becomes a removable **chip**; plain words
search every field. Everything ignores case and accents (`uber` finds `über`). A
token needs a word start before it (`hashtag:x` is plain text), and tokens can
repeat (`tag:b1 tag:verb`).

| You type | Finds |
|---|---|
| `haus küche` | cards whose text has both words, in any field, in any order |
| `"die stunde"` | the exact phrase |
| `deck:german` or `deck:"German Verbs"` | cards in decks whose name starts with that |
| `section:verbs::b1` | cards in that section (subdeck) and below |
| `tag:algo` / `-tag:leech` | cards with / without that tag (a parent tag matches its children) |
| `level:b1`, `type:verb`, `category:"core patterns"` | cards whose field has that value — **only when a filter group with that field name exists here**; otherwise the token stays text and a hint says "No field called 'level' here." |
| `is:new` `is:notstarted` `is:learning` `is:review` `is:mastered` `is:known` | cards in that status |
| `is:due` / `is:duetoday` | cards due now / due before the end of today |
| `is:fav` `is:flagged` `is:suspended` `is:buried` `is:paused` (and `-is:…`) | cards with (or without) that marker |
| `is:hard` `is:young` `is:leech` | hard cards (low ease), recent cards (interval ≤ 7 days), leeches (8+ lapses) |
| `dir:1` | cards of direction 1 (the first template; `dir:2` is the reverse) |

The parser is `src/domain/searchParse.ts`; the full rules are in spec §4.2.

## Architecture

```
src/
  app/              expo-router routes
    (tabs)/         Today (index) · Library · Progress · Settings (a nested stack:
                    study, reminders, data, algorithm)
    deck/[id].tsx   the deck page (hub)
    session.tsx     Study / Study ahead / Practice, all study modes
    complete.tsx    the session summary
    triage.tsx      "Choose what to learn" (Learn / I know it / Later)
    import.tsx      the import wizard (.apkg, AnkiWeb, CSV, backup)
    card-editor.tsx · deck-editor.tsx · onboarding.tsx · help.tsx
  components/       ui/ (the "paper & ink" kit: buttons, chips, sheets, badges …)
                    and one folder per feature (today, library, deck, study, …)
  domain/           PURE logic, no React, no I/O (most files have a .test.ts next to them):
                    model.ts (the note model types), query.ts + searchParse.ts
                    (one filter language), facets.ts + libraryIndex.ts (derived
                    filter groups), life.ts + schedule.ts + scope.ts (statuses, the
                    one scheduler, "Study N" === session), srs.ts (SM-2), import/
                    (read → plan), lang/ (German article rules), triage, noteOps …
  store/            the data layer without React: engine.ts (boot, actions),
                    reducer.ts (every state change as a pure command),
                    persistController.ts (when saving is allowed), migrate.ts +
                    migrateV3.ts (every old data version → schema 3), storage/
                    (the SQLite row store), selectors.ts, DataContext.tsx (the thin
                    React shell), backup.ts, history.ts
  platform/         thin wrappers around Expo APIs: files, sharing, haptics,
                    notifications and the reminder plan, deck images, CSV export
  variants/         the content packs: generic/pack.ts (empty) and the German pack
  content/          the glossary and the Help texts
  theme/            design tokens and the light (Paper) / dark (Evening) themes
```

Key rules (each one is pinned by tests; spec §3.12 lists where):

- **Data is never lost.** The data is schema 3 (the note model) in a SQLite row store
  (`maranki-rows.db`; a save writes only the changed rows, in one transaction). Every
  older version (the v2.0.x app, the German fork, earlier builds) is migrated on load
  by `migrate()`, and the raw old document is copied to `backups/` first. A read
  failure blocks every write (C1), so a problem never overwrites intact data.
  Backups restore through the same `migrate()`.
- **All changes go through `reducer.ts`.** Each action is a pure function
  `(state, input, ctx) → { state, result }`; there is no "patch anything" action.
  Practice never changes the schedule or the daily counts (H3); a session killed
  mid-way is banked exactly once, silently, at the next start (M5).
- **One scope, one scheduler.** `scope.ts` is the only place that turns a filter
  into a card list, a "Study N" number or a session queue, so the number and the
  session always agree.

## Tests

```bash
npm run verify    # = deck-file check, tsc --noEmit, expo lint, jest  (the same gate as CI)
npm test          # jest only
```

`npm run verify` must be green before every commit; CI runs the same checks on every
push and pull request (see [`RELEASING.md`](RELEASING.md)). React Compiler is on, and
its lint rules are errors (no `Date.now()` in render — use `useNow()`; no
synchronous `setState` in an effect).

## Documents

- [`docs/product-spec.md`](docs/product-spec.md) — **the source of truth**: the
  product, the glossary, the data model, the filter language, import, study,
  every screen and its copy, the build variants, and the work plan in waves.
- [`RELEASING.md`](RELEASING.md) — how to cut a release, the CI gate, the variants
  and the signing-key rules.
- `design/` — the "paper & ink" design system handoff (tokens, the HTML mockup).
