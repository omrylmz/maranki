# Maranki

A spaced-repetition vocabulary app — **React Native + Expo**, rebuilt from the ground up
to implement the **"paper & ink" design system** (`design/`, exported from Claude Design,
canonical mockup: `design/ui_kits/app-v2/`).

Words are the hero: warm parchment surfaces, espresso ink, a deep-pine brand color,
honey-amber for the habit loop, Newsreader serif for vocabulary, Hanken Grotesk for UI,
Spline Sans Mono for IPA and intervals. Two themes — light **Paper** and warm-dark
**Evening** — switchable in Settings (Light / Evening / System) or via the moon toggle
on Home.

## Run it

```bash
npm install
npx expo start        # then i (iOS simulator) / a (Android) / scan QR in Expo Go
```

First boot seeds a lived-in library (5 decks, ~100 real German/Spanish/French cards
with spread SRS states, 5 weeks of session history) and opens the language-first
onboarding tour. Useful checks: `npx tsc --noEmit` · `npx expo lint`.

## Architecture

```
src/
  app/                  expo-router routes
    (tabs)/             Home · Study · Library · Progress · Settings (custom tab bar)
    session.tsx         the study loop (full-screen overlay)
    complete.tsx        session payout + keep-going hub
    card-editor.tsx     deck-editor.tsx · import.tsx · onboarding.tsx
  domain/               pure logic: types, SM-2 engine (srs.ts), queue building +
                        "trustworthy numbers" (queue.ts), XP/levels/achievements
                        (gamification.ts), seed corpus, TTS, import samples
  store/                DataContext (AsyncStorage-persisted state + all actions),
                        SnackbarContext, useNow
  theme/                tokens.ts (verbatim from design/colors_and_type.css, both
                        themes) + ThemeContext (mode + moon-toggle override)
  components/ui/        the primitive kit mirroring the mockup's ui.jsx
  components/sheets/    PeekSheet · CreateSheet · StreakSheet · CardPeek
```

Key contracts (from `design/ui_kits/app-v2/WIRING.md`):

- **SM-2 with Anki-style learning steps.** `predictAll()` previews every rating's next
  interval before the user commits — the rating buttons display real outcomes.
- **Undo is review-log-backed** (A1): each rating snapshots the card's SRS fields;
  undo restores them and decrements the daily tallies.
- **"Again" requeues at `idx+3`** inside the running session, visibly tagged.
- **One ready count** (`computeReady`) feeds the Home hero, Study badge, deck rows
  and launchpad — never a raw count where a limit-aware number is meant.
- **Cram never writes the schedule.** XP pays out at session end, itemized exactly
  as the Complete screen shows it (cards ×2 + correct ×2 + streak 10 + run 8).
- **Streak freezes** bridge one missed day automatically and are earned at 7-day
  milestones (capped at 3); the streak sheet derives its 14-day strip from real
  session history.

## What's real vs. staged

Genuinely wired end-to-end: the session loop (reveal → rate → undo → requeue →
milestones → payout), theming, onboarding (choices persist), goals + algorithm
tuning (live SM-2 knobs with per-knob reset), library search with working
`level:` / `type:` / `deck:` tokens, filter sheet + sort, bulk actions
(favorite/flag/suspend/study-these), card & deck editors with unsaved-guard and
safe delete (move/keep/delete-all), deck duplicate, TTS audio (expo-speech),
factory reset (hold-to-erase actually re-seeds), and the import flow — which
writes a real sample deck with preserved SRS fields and honest dedupe.

Staged with design-faithful UI, awaiting backend work (tracked in WIRING.md):
real `.apkg`/CSV parsing + AnkiWeb fetch (import currently uses bundled sample
payloads; error states + CSV column-mapping stage not built), pronunciation
*recording* (UI staged; capture needs expo-av), backup export/restore files,
reminders scheduling, typing/quiz study modes, the collection editor, and
Stats CSV export.

## Design provenance

`design/` holds the full handoff bundle: `BUNDLE_README.md`, the design-system
`README.md` (tone, foundations, iconography), `colors_and_type.css` (the token
source of truth), the interactive HTML/JSX mockup (`ui_kits/app-v2/`), preview
cards, brand assets, and the original chat transcripts. The raw export archive
is kept at `design/_export-bundle.tgz`.
