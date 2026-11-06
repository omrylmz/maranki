# Saved-state fixtures

These files are **documents that old builds of Maranki saved** under the
AsyncStorage key `maranki.state.v1`. The migration code (`migrate()`, wave 1)
and the storage round-trip tests read them, so we test against real data, not
against data we imagine (spec §3.1 rule 2, unit W0-1).

## How they were made: by running the old code

`scripts/generate-state-fixtures.sh` does it (spec W0-1, adapted: no emulator).
For each old build it:

1. checks out the old commit in a temporary, detached git worktree;
2. links this repo's `node_modules` into it (the old builds use the same Expo
   SDK 56 packages);
3. writes a temporary jest test that renders **that build's own
   `<DataProvider>`** (react-test-renderer + the AsyncStorage jest mock + jest
   fake timers) and calls the store actions **in the same order and with the
   same arguments as the old screens** (onboarding, deck catalog, import,
   Browse bulk bar, the session screen's `rate()` / `exitNow()`);
4. copies the string the old `DataProvider` saved — its own `serialize()`,
   i.e. `JSON.stringify(state)` — **byte for byte** into the fixture file;
5. removes the temporary worktree. Nothing is committed in the old repos.

Because the clock is a fake clock and the script runs jest with `TZ=UTC`, two
runs of one step write the same bytes. (A run of `main`, `derived` or `fork` does
not equal the committed file, because of the next paragraph. The tests pass with
both.) The content is **synthetic**: curated catalog
words, a made-up CSV, and notes from `src/domain/__fixtures__/anki`. There is
no personal data.

**This repo is public, and the author's Anki decks are private.** So
`scripts/make-synthetic-fixtures.py` replaced the words of the cards that came
from those decks in `v0-german-fork.json` and the four `v1-*.json` files
(their structure, ids and numbers are what the old build saved). A regeneration
from the made-up samples needs no extra step. Only a run on real samples needs
that script, before you commit.

Each file is one line (that is what `serialize()` writes). To read one:
`node -e 'console.log(JSON.stringify(require("./v0-v2.0.2.json"), null, 2))'`
or `jq . v0-v2.0.2.json`.

(One file is different: `v0-v2.0.2-device.json` was read from a real
device, not made by the script. See its section below.)

**Do not edit these files by hand.** Change the script and regenerate. The
`state fixtures` block in `src/test/factories.test.ts` pins the facts below,
so a wrong regeneration fails the tests. Load them in tests with
`stateFixtureRaw(name)` (the raw string) or `stateFixture(name)` (parsed) from
`src/test/factories.ts`.

## The files

| File | Schema | Made from | What is inside |
| ---- | ------ | --------- | -------------- |
| `v0-v2.0.2.json` | v0 | tag `v2.0.2` (commit `0f22b60`, the public APK) | 74 cards in 3 decks, 1 session, 6 review-log entries, a killed session's marker **without** `studyDay` |
| `v0-german-fork.json` | v0 + `studyDay` | the old German fork | 64 cards in 3 decks, 1 session, 6 review-log entries, a marker **with** `studyDay` |
| `v0-empty-library.json` | v0 | tag `v2.0.2` | no cards and no decks, but 1 session and 2 review-log entries |
| `v1-main-1333d48.json` | v1 | commit `1333d48` (main, front/back model) | 24 cards in 3 decks, 1 session, 6 review-log entries, a marker with `studyDay` |
| `v1-marker-no-studyDay.json` | v1 | derived from `v1-main-1333d48.json` | the same, but the marker has no `studyDay` |
| `v1-orphan-card.json` | v1 | derived from `v1-main-1333d48.json` | the same, but one card's deck does not exist |
| `v1-nan-fields.json` | v1 | derived from `v1-main-1333d48.json` | the same, but 9 cards have broken numbers or texts |
| `v0-v2.0.2-device.json` | v0 | **a real device**: the v2.0.2 release APK on an Android emulator (not made by the script, see below) | 68 cards in 2 decks, 1 session, 9 review-log entries, 1 favorite, 1 flag, a killed session's marker (2 Good ratings) **without** `studyDay` |

### `v0-v2.0.2.json` — a v2.0.2 user (the public release)

Card shape `{word, article, base, tr, ipa, ex, exTr, level, type, lang}`, deck
shape `{flag, lang, level}`, settings `{ttsEnabled, autoPlayAudio,
pronunciationPrompt}` — spec §3.1 "version 0". What the script did:

1. **Mon 6 Jul 2026, 07:30 UTC.** Onboarding: pick German → the two curated
   decks "German — Everyday" (44 cards, has "die Stunde") and "German —
   Conversation" (24); goals 30 / 10.
2. "Start learning" → a session rated good, again, easy → close button: the
   partial session is banked (`sessions[0]`, XP, streak 1, "first-steps").
3. Settings: **"speak the word on reveal" on** (`autoPlayAudio: true`, not the
   default — so the `autoPlayAudio → autoReadAloud` mapping is really tested).
4. Import → From a file → `Spanish kitchen.csv` (6 cards; header
   `Palabra,Traducción,…`, so the language is Spanish; levels, types, IPA and
   tags filled by the v2.0.2 CSV parser).
5. Browse: favorite "aufräumen" and "el tenedor"; flag "der Schlüssel".
6. **Tue 7 Jul, 08:10.** Study → good, hard, good → the OS kills the app. The
   marker (`inProgressSession`, 3 reviews) stays on disk, **without
   `studyDay`** (v2.0.x never wrote it).

### `v0-german-fork.json` — a German fork user

The fork keeps the v0 card shape **and** writes `studyDay` in the marker.

1. **Tue 14 Jul 2026, 06:50 UTC.** Onboarding → "Add your German decks":
   German Verbs, then German Grammar. This is the fork's `importBundledDeck()`
   without the asset I/O: the fork's own pure `.apkg` mapping
   (`parseAnkiModels`, `groupNotesBySection`, `ankiDeckName`) runs on the rows
   of `src/domain/__fixtures__/anki/german_{verbs,grammar}.json` (20-note
   samples of the bundled decks), then `importDeck({ flag: '🇩🇪', lang:
   'German' })`. So these cards have a `level` (from the Level field) and
   `type: null`. Goals 20 / 8.
2. "Start learning" → good, good, again → close button (banked with
   `studyDay`).
3. Study tab "+" → curated "German — Conversation" (24 cards with `level`,
   `type`, `ipa`, `exTr`).
4. Browse: favorite 2, flag 1.
5. **Wed 15 Jul, 21:15.** Study → good, easy, hard → killed. Marker
   `studyDay: '2026-07-15'`.

### `v0-empty-library.json` — a v2.0.2 user who deleted everything

**Wed 8 Jul 2026, 18:45 UTC.** Onboarding: pick French ("French — Basics"),
study 2 cards, close; then the deck editor → "Delete the deck and its cards".
Result: `cards: []`, `decks: []`, but a session, XP, a streak and 2 review-log
entries whose cards no longer exist. With no cards and no decks, **only the
settings** (`ttsEnabled` present, `readAloudEnabled` missing) show it is v0
(spec §3.1, `detectVersion`).

### `v1-main-1333d48.json` — a generic-app (main) user

Card shape `{front, back, example?, notes?}`, deck shape `{icon}`, setting
`readAloudEnabled` — spec §3.1 "version 1".

1. **Mon 20 Jul 2026, 12:05 UTC.** Onboarding (goals 30 / 10).
2. Deck editor: "World capitals" 🌍; card editor: 5 cards (some with example,
   notes, tags).
3. Import → `Chemistry basics.csv` (6 cards, positional front/back/example/
   notes/tags).
4. Import → `Algo_Patterns.apkg` (the 20-note sample) → "Choose subdecks":
   keep "Core Patterns" and "Dynamic Programming", drop "Advanced Patterns" →
   deck "Algo Deck" (13 cards; the image tags were stripped by
   that build).
5. Settings: session size **30** (not the default 50).
6. Browse: favorite "Japan" and "O3"; flag one coding card.
7. A session: easy, good, again → close button.
8. **Tue 21 Jul, 07:40.** Study → good, hard, good → killed. Marker
   `studyDay: '2026-07-21'`.

### The three derived files (made by the `derived` step of the script)

Each one is `v1-main-1333d48.json` with **one kind of damage**, saved with
`JSON.stringify` like `serialize()`. They test the "repair, never drop" rules
(spec §3.1 rule 4, §3.3 `sanitize`).

- **`v1-marker-no-studyDay.json`** — `inProgressSession.studyDay` removed.
  Real v1 builds always write it (it came in 899a1d6, before the v1 model), so
  this is a synthetic edge case: a v1 document holding a marker from an older
  build. `attributionDay()` must fall back to the completion time (tally.ts).
- **`v1-orphan-card.json`** — the card "NaCl" points at `d-deleted-deck`, a deck
  that does not exist (the old "move cards to a deleted deck" bug, H2).
  Expected repair: the card moves to the "Unfiled cards" deck.
- **`v1-nan-fields.json`** — one repair case per card. JSON cannot store `NaN`
  or `Infinity`: `JSON.stringify` writes them as `null`, so **a NaN on disk is
  `null`**.

  | Card | Damage | Expected repair (§3.3) |
  | ---- | ------ | ---------------------- |
  | France | `ease: null`, `due: null` (were NaN) | `ease → startingEase`, `due → now` |
  | Japan | `ease: 1.1` | `ease → 1.3` |
  | Canada | `intervalDays: null` (was Infinity), `reps: null`, `lapses: null` | `→ 0` |
  | Kenya | `reps: -2`, `lapses: -1` | `→ 0` |
  | Australia | `reps: 3`, `stepIndex: 1.5` | `stepIndex → 0` (reps > 0) |
  | H2O | `reps: 0`, `stepIndex: -1` | `stepIndex → null` (reps = 0) |
  | CO2 | `front: 42`, `back: null` | `front → '42'`, `back → ''` |
  | CH4 | `due: '2026-07-22'` (a text) | `due → now` |
  | Fe | `back` missing | `back → ''` |

### `v0-v2.0.2-device.json` — the REAL v2.0.2 app on a phone

All the other files come from running the old code in jest. This one comes
from the **real release build** (the public v2.0.2 APK) running on an
Android emulator (Android 36), so it proves that `migrate()` reads what a
real phone wrote, not only what jest wrote. The study data is synthetic
(curated catalog words), so there is no personal data.

What was done in the app (24 Oct 2026, the emulator's local time):

1. Onboarding: pick German → "German — Everyday" (44 cards, has "die
   Stunde") and "German — Conversation" (24); goals 30 / 10.
2. A session: 7 ratings (5 new cards) → close: banked as `sessions[0]`,
   XP 34, streak 1, "first-steps".
3. Library: favorite "die Stunde"; flag "aufräumen".
4. A second session: Good, Good → the app was force-stopped. The marker
   (`inProgressSession`, total 2) stays on disk, **without `studyDay`**.

How the file was read: the app's AsyncStorage database `RKStorage` was
copied from the emulator, and the value of the key `maranki.state.v1` in
its table `catalystLocalStorage` was saved **byte for byte**. (The `sqlite3`
command line adds a newline at the end of its output; that newline is not
part of the stored value, so it is not in the file.)

The tests that read it: `migrate.test.ts` ("migrate — v0 on a real device")
and `migrateV3.test.ts` ("v2toV3 — the real-device v2.0.2 document"). It is
**not** in `STATE_FIXTURES` (`src/test/factories.ts`); those two test files
read it directly. **Never edit it**: it cannot be made again by the script.

## Regenerate

```sh
scripts/generate-state-fixtures.sh            # all files
scripts/generate-state-fixtures.sh v202       # only v0-v2.0.2 + v0-empty-library
scripts/generate-state-fixtures.sh fork       # only v0-german-fork (needs the old German fork)
scripts/generate-state-fixtures.sh main       # only v1-main-1333d48
scripts/generate-state-fixtures.sh derived    # only the three derived files
```

The steps read the made-up Anki samples in the repo, so the output is made up
too. **Never copy real samples into `src/`:** see "Test fixtures" in
`RELEASING.md`. The `fork` and `all` steps also need `FORK_REPO` and `FORK_REF`.
