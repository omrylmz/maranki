# Maranki — App Redesign v2

The extensive, "killer UI/UX" redesign of the Maranki app — a ground-up rebuild of every
screen and flow in the paper-and-ink design system, executed with a **ledger/notebook**
visual language: hairline rows on warm paper (no card-soup), oversized Newsreader serif
as the hero of every surface, tabular mono numerals, fine ink-line data viz.

It implements the redesign plan's P0/P1 moves end-to-end:

| Move | Where |
|---|---|
| One stateful "Today" command, straight into the session (D1) | Home — the **card-stack invitation**: today's actual first word sits on the page |
| Undo every rating; "Again" requeues visibly (A1) | Study session — header undo + snackbar |
| Terminal states → momentum hub (A2) | Session complete — study ahead / hardest / cram |
| Rating breakdown + itemized XP payout + achievements (A3, C1) | Session complete |
| Streak freezes visible, earnable, explained (C2) | Streak chip + streak sheet |
| Study = do, Browse = manage; universal peek sheet (B1) | Study launchpad + Library |
| Global create system (B2) | FAB → create sheet on Study/Library |
| Trustworthy counts ("N cards · M due") (B4) | Deck & collection rows everywhere |
| Multi-select + bulk actions (B8) | Library — Select mode + action bar |
| Cause-split empty states (B7) | Library no-matches state |
| Editor safety: unsaved guard, safe deck delete (B9) | Card & deck editors |
| Pronunciation record/playback surfaced (C4) | Card editor + card peek "Say it" |
| One Import hub with in-app AnkiWeb search (B6/B6b) | Import — staged, cancellable, honest preview |
| Stats that drive action (C5) | Progress — due/weak-card launchers |
| Grouped, searchable Settings; unmistakable resets (E1/E2) | Settings + drill-ins |
| Language-first onboarding (F1) | Onboarding (Settings → Replay the tour) |
| Evening theme | Moon toggle on Home, segmented control in Settings, Tweaks |

## Run it
Open `index.html`. Boots into an iPhone frame on **Home**. Tap the card stack or
**Start review** for the full loop: reveal → rate (predicted intervals) → undo snackbar →
session complete payout → keep-going hub. All five tabs, the FAB create menu, import,
editors and onboarding are live. **Tweaks** (toolbar): theme, paper grain, Home hero variant.

## Files
| File | What it is |
|---|---|
| `index.html` | Entry point — React, fonts, icon helper, all JSX below |
| `ios-frame.jsx` | Device bezel |
| `ui.jsx` | Tokens (`T`) + primitives: Btn, Row (ledger), Ring, SegCtrl, Sheet, TabBar, Snackbar… |
| `data.jsx` | Sample German/Spanish content, decks, collections, achievements |
| `screen-home.jsx` | Ritual page: greeting, card-stack invitation, goal ledger, deck rows, streak sheet |
| `screen-session.jsx` | The loop: stacked card, reveal, 4-button rating, undo, milestones, exit confirm |
| `screen-complete.jsx` | Payout: tiles, rating breakdown, XP tally, achievement, momentum hub |
| `screen-launchpad.jsx` | Study tab + universal PeekSheet + CreateSheet |
| `screen-browse.jsx` | Library: search/tokens, rows, CardPeek, multi-select bulk |
| `screen-stats.jsx` | Progress: level, streak/mastery heroes, launchers, heatmap, achievements wall |
| `screen-settings.jsx` | Grouped searchable hub + Study/Algorithm drill-ins + danger zone |
| `screen-editors.jsx` | Card editor (with pronunciation recording) + deck editor (safe delete) |
| `screen-import.jsx` | Import hub: AnkiWeb / file / backup, staged flow |
| `screen-onboarding.jsx` | Language-first tour |
| `app.jsx` | Orchestrator: tabs, overlays, sheets, snackbar, theme, Tweaks |
| `WIRING.md` | **Backend handoff** — callback contract, data shapes, stub inventory, Anki integration coverage |

Components export to `window` (each file ends with `Object.assign(window, {...})`).
All color/spacing reads the CSS vars from the root `colors_and_type.css`, so the whole
app re-themes by flipping `data-theme="dark"` on the wrapper.
