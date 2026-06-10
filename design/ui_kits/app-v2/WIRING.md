# Maranki v2 mockup — wiring handoff (for Claude Code)

Audited 2026-06-10. This is the contract between the mockup (`ui_kits/app-v2/`) and the real
React Native codebase (`omrylmz/maranki`). Everything below was verified against the source files;
spec references (A1, B6b, …) point to `redesign/maranki-redesign-plan.md` and
`redesign/maranki-functional-spec.md` in the user's local `redesign/` folder.

## 1. Architecture

- **Entry:** `index.html` loads React 18 UMD + Babel, then every `*.jsx` in dependency order
  (frame → ui → data → screens → tweaks → app). Each file ends with `Object.assign(window, {...})` —
  that is the only module system; keep it if you add files.
- **One orchestrator:** `app.jsx` owns all cross-screen state: `tab`, `overlay`
  (`session | complete | cardEditor | deckEditor | import | onboarding`), the universal `peek` sheet,
  `createOpen`, `streakOpen`, the global snackbar, and theme. Screens are stateless about navigation —
  they only call the callbacks they're handed.
- **Theming:** every color reads a CSS var from `colors_and_type.css`; flipping `data-theme="dark"`
  on the wrapper re-themes everything. Maps to the existing token system in `src/constants/`.

## 2. Callback contract (what the backend must implement)

| Callback | Fired from | Real implementation |
|---|---|---|
| `onStartSession()` | Home hero/stack, deck "due" buttons, launchpad, peek sheet, stats, complete-screen hub, onboarding | Build queue via SM-2 (`src/utils/sm2.ts`) + daily caps; thread session `kind` (scheduled / ahead / cram) per plan A2 |
| `rate('again'|'hard'|'good'|'easy')` | Session rating row | SM-2 grade write. **"Again" requeues in-session at `idx+3` (uncapped, Anki learning-step semantics)** — see `screen-session.jsx → rate()` |
| `undo()` | Session header + snackbar | Snapshot stack of `{queue, idx, counts, run}` — back it with a real review-log revert (A1) |
| `onComplete({counts, total, bestRun})` | Last rating | `recordSession` with full tallies (fixes OPP-DATA-1) |
| `onSnack(text)` | everywhere | FeedbackProvider snackbar/undo channel (already built in repo) |
| `setPeek(deck\|collection)` | Any deck/collection row | Universal peek sheet (B1); `{isCollection: true}` flags collections |
| `onEditCard(card)` / `cardEditor` overlay | Library row → peek → Edit | `card-editor?cardId` route |
| `onImport()` | Launchpad header, create sheet, Settings → Your data, onboarding step 1 | The unified Import hub (B6) |

## 3. Intentional stubs (snack-only — wire these for real)

These render feedback but mutate nothing; each maps to an existing repo function per the plan:

- **Collection editor** (create sheet + peek "Edit" on a collection) — plan B2/B8
- **Resume paused deck** (launchpad) — `updateDeck({active: true})`
- **Bulk actions** (library select mode: favorite / flag / suspend / study-these) — B8
- **Card peek toggles** (Favorite / Learning / Learned) + **"Say it"** pronunciation — C4, `PronunciationPractice` + `saveRecordingForCard`
- **Audio play buttons** (session card, card peek) — TTS or imported Anki audio
- **Session more-sheet**: Reschedule, Bury (snack ✓), Flag, Switch mode
- **Sort** (library) and **filter sheet chips** (visual only — chips don't hold state)
- **Settings**: language picker, reminders, help, export/restore (inline progress pattern per E3 is mocked), factory reset ("Hold to erase" is a demo no-op)
- **Stats**: export history (CSV), "Review weak cards" launcher
- **Editors**: Save/Delete/Duplicate emit snacks; unsaved-guard + safe-delete UI is fully wired

Everything else — navigation, tabs, overlays, sheets, session loop with undo/requeue,
theme switching, onboarding flow, import staging — is genuinely wired in-mockup.

## 4. Data contracts (`data.jsx` → backend models)

- `QUEUE` / `LIB` cards: `{id, word, article, base, tr, ipa, ex, exTr, level, type, state, lang, step, interval, fav, pred:{again,hard,good,easy}}`.
  `pred` = **predicted next interval per rating** — compute from SM-2 before render (the rating buttons display it).
  `state` ∈ `new | learning | review | mastered | due`.
- `DECKS`: `{id, name, flag, lang, total, mastered, learning, neww, due, level, builtin, active}` —
  `due` must be the **limit-aware ready count**, not raw due (B4 "trustworthy numbers").
- `COLLECTIONS`: saved smart filters `{id, name, icon, count, due, desc, sort}` — live queries, not folders.
- `PERSON`, `READY`, `DAYS14`, `HEAT`, `ACHIEVEMENTS`: dashboard aggregates; `READY.total` also feeds the Study tab badge.

## 5. Anki integration — coverage & remaining work

Mockup (`screen-import.jsx`) implements the spec's import contract:

| Requirement (spec §4.8A / plan B6+B6b) | Status in mockup |
|---|---|
| In-app AnkiWeb search (B6b: `searchAnkiWebDecks()` exists, never called) | ✓ search field + results list |
| Paste AnkiWeb URL / numeric deck ID | ✓ detected (`/^(https?:\/\/|ankiweb\.|\d{6,})/`) → "Import from AnkiWeb" row → preview |
| `.apkg` / `.csv` file with auto-detect | ✓ file source ("we'll detect which") |
| Backup (JSON) restore folded into hub | ✓ third source tab |
| Honest preview before write ("nothing imported yet") | ✓ counts, media, **duplicate count (dedupe by Anki note id)** |
| SRS fidelity preserved (ease, interval, due, suspended/buried, flags, tags) | ✓ stated in preview + importing copy |
| Cancellable past preview, nothing written | ✓ cancel during progress |
| "Go study" forward action on done | ✓ → starts session |
| No-results state | ✓ cause-split message |

**Still to build in code (not mocked — backend/UI work):**
1. **Error states** (OPP-STATE-12): AnkiWeb metadata-fetch failure, offline, and `.apkg` parse failure
   must surface visibly with a browser-handoff fallback — never silently swallowed.
2. **CSV column-mapping stage** — copy promises "you'll confirm the mapping"; the conditional
   mapping step is not mocked. Follow the same staged skeleton (source → preview → importing → done).
3. **Real progress** — replace the interval-timer fake (`setProg`) with pipeline progress; keep the ring.
4. Preview is hardcoded to one deck — bind to the parsed file/AnkiWeb metadata.
5. **Export side**: spec §5.6 is JSON backup + CSV exports (mocked in Settings). `.apkg` export is
   **not** in scope per spec — Anki integration is import-only.

## 6. Known mockup-isms (fine for design, don't copy to prod)

- `T` reads CSS vars via inline styles — in RN, use the token objects in `src/constants/`.
- `TOPPAD`/`TABH` are fixed px — use safe-area insets.
- Session seeds `run = 4` for a mid-session feel; complete-screen falls back to demo numbers
  when opened without a result; XP math and level-bar fill are illustrative.
- Home greeting/date is hardcoded ("Tuesday · June 9") — make time-aware per spec §4.1.
