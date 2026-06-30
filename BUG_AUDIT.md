# Maranki — Bug Audit

_Multi-agent adversarial code audit. 20 finder missions (subsystem × lens) → severity-scaled adversarial verification (2 skeptics for high/critical, default-to-refuted) → coverage critic. 77 raw findings → **71 survived verification** (69 confirmed, 2 uncertain), 6 refuted. Synthesis below was hand-authored from the cached findings after the run hit a monthly spend limit during round 2._

Baseline at audit time: `tsc --noEmit` clean · `expo lint` clean · `jest` 58/58 green. None of the issues below are caught by the current static checks or tests.

## Executive summary

After de-duplication the 71 survivors collapse to **~32 distinct defects**:

| Severity | Distinct issues |
|---|---|
| 🔴 Critical | 1 |
| 🟠 High | 6 |
| 🟡 Medium | ~13 |
| ⚪ Low | ~12 |
| ❓ Needs confirmation | 2 |

### Top must-fix

1. **🔴 Data loss on a corrupt/failed read.** A rejected `AsyncStorage.getItem` _or_ a `JSON.parse` throw on a truncated blob silently falls back to the blank seed, which the debounced save then writes over the user's intact data. The app's own interrupted writes can produce the truncated blob. — `src/store/DataContext.tsx:167`
2. **🟠 A freshly added deck cannot be studied from its own row or peek.** Every per-deck/collection launch control is gated on `due > 0`, but `due` excludes new cards. An all-new deck (every curated deck right after it's added) shows a "caught up" checkmark with no launch button, and its peek launches an **empty** "study ahead" session. Breaks the core blank-slate onboarding path. — `index.tsx:484`, `study.tsx:174/286`, `PeekSheet.tsx:182`
3. **🟠 Deleting your only deck destroys its cards.** The delete sheet defaults to "Move cards" with an empty target when no other deck exists; `deleteDeck` reassigns every card to `deckId:''` (orphaned/invisible) and the toast falsely says "cards moved." — `deck-editor.tsx:103`, `DataContext.tsx:475`
4. **🟠 "Cram (free practice)" consumes the daily review allowance.** Despite "never changes your schedule," each cram rating increments `dayDone.reviews`, which hides genuinely-due scheduled cards for the rest of the day, and it can't be undone. — `DataContext.tsx:203`
5. **🟠 Malformed AnkiWeb search response hard-freezes the app.** `parseDeck` reads a length prefix without clamping to the buffer; the varint reader then can't advance and `while (pos < end)` spins forever on the JS thread. — `ankiweb.ts:131`

### Systemic themes

- **Persistence is fragile and silent.** No error-class distinction on load, swallowed save errors, no flush on background, and a factory-reset "export backup" that writes nothing. Several distinct findings, one root posture: errors are hidden and the happy path assumes storage never fails.
- **Daily-allowance accounting leaks.** `dayDone.reviews` is incremented for cram, for new cards, and for learning steps; per-deck counts apply the _global_ remaining; the "N due" label is capped by remaining; the goal stepper never updates the limit. The "trustworthy numbers" invariant holds inside `queue.ts` but is undermined by how callers feed and read it.
- **`due` vs `sessionCount` confusion in the UI.** The domain deliberately separates the due-urgency count from the launch size, but five surfaces gate on `due` while displaying/launching `sessionCount`.
- **Stale-snapshot reads in the reducer.** `completeSession` scores achievements/mastery/streak XP from a pre-final-rating `stateRef` snapshot, so threshold-crossing unlocks lag a session and the streak XP bonus is paid per-session not per-day.
- **Language is forced to German on every import**, so Spanish/French/Italian decks get a German TTS voice and German-specific article handling.
- **Untrusted-input parsers lack bounds.** Protobuf length prefixes and network/zip buffers are unclamped (freeze / OOM); CSV delimiter and header detection misfire on realistic files.

---

## 🔴 Critical

### C1 — Transient read failure or corrupt blob silently wipes all user data
`src/store/DataContext.tsx:157-183` · _confirmed (2 votes)_

The load effect treats every failure identically: if `AsyncStorage.getItem` rejects (native DB error, storage pressure) **or** `JSON.parse` throws on a partially-written/truncated blob, the `.catch(() => {})` swallows it and `.finally(() => setReady(true))` flips `ready` true while `state` is still the initial blank seed. The save effect (`deps [state, ready]`) then fires on the `ready` transition and ~400 ms later runs `setItem(STORAGE_KEY, JSON.stringify(seed))`, permanently overwriting the intact stored document.

**Reachable trigger:** the app's own debounced `setItem` is interrupted by an OS kill/suspend mid-write → truncated blob on disk. Next launch: `raw` is non-null, `JSON.parse(raw)` throws → `.catch` → seed → overwrite. A user with 500 cards, a 40-day streak and months of history loses everything, no backup.

**Fix:** distinguish error classes. On `getItem` rejection, do **not** enter writable mode — surface a retry and block saving so good data is never overwritten. On parse failure, copy the raw blob to a backup key before re-seeding. Treat only `raw === null` as a genuine first boot. Consider writing to a temp key and renaming, so a partial write can't corrupt the live key.

> Verification note: a sibling finding (`:170`) describing the same code path was _refuted_ as "latent footgun, harm unreachable." That instance reasoned about the benign first-boot (null-raw) case. The confirmed instance is correct for the data-present + read-failure/parse-throw path, which is the dangerous one.

---

## 🟠 High

### H1 — A deck/collection whose only ready cards are new can't be launched from its row or peek (5 sites, one root cause)
`src/app/(tabs)/index.tsx:484` · `src/app/(tabs)/study.tsx:174` · `src/app/(tabs)/study.tsx:286` (collections) · `src/components/sheets/PeekSheet.tsx:182` · _confirmed (2 votes), found independently by 3 missions_

`deckStats.due` / `collectionStats.due` count only review + learning cards (both require `reps > 0`); brand-new cards are excluded. But every launch control **displays and launches `sessionCount`** (new-inclusive). So a deck with `due === 0, sessionCount > 0`:
- **Home & Study rows** (`s.due > 0` gate): render a green "caught up" checkmark with **no launch button**.
- **PeekSheet** (`study(info.due === 0)`): labels the CTA "Nothing due — study ahead" and launches `kind:'ahead'`, whose `buildQueue` filters `reps > 0 && due > now` → **empty queue** → "Nothing to study here."

This is the state of **every curated deck immediately after it's added** (`materializeCatalogDeck` mints all cards `reps:0`), i.e. the primary new-user flow. The aggregate "Start review" still works, so it's not a total dead-end — hence High, not Critical.

**Fix:** gate the launch button and the peek CTA on `sessionCount > 0`, not `due > 0`; keep the "N due" _text_ using `due`. In PeekSheet, only take the `ahead` path when `sessionCount === 0` and upcoming reviews exist.

### H2 — Deleting the only deck via the default "Move" option orphans every card (silent data loss + false confirmation)
`src/app/deck-editor.tsx:52-53,103` · `src/store/DataContext.tsx:474-475` · _confirmed (2 votes), found by 2 missions_

The delete sheet defaults `delMode:'move'` and `moveTarget = otherDecks[0]?.id ?? ''`. When the deck is the user's only deck, `otherDecks` is empty so `moveTarget` stays `''`, the target picker is hidden, but the "Move cards… keeps every card and its progress" radio is pre-selected and the confirm button is enabled. `deleteDeck(id, {kind:'move', targetDeckId:''})` then does `cards.map(c => c.deckId===id ? {...c, deckId:''} : c)` with no validation. Orphaned cards (`deckId` matching no deck) are excluded by `activeCardPool`, so they vanish from Study/Home/Stats — while the toast reads "cards moved to another deck."

**Fix (two layers):** (1) In `deck-editor`, when `otherDecks.length === 0` default to `keep` and disable the `move` option. (2) In the reducer, make the no-orphan invariant authoritative: if `targetDeckId` names no existing deck, fall back to the `keep`/unfiled path instead of blindly reassigning.

### H3 — "Cram (free practice)" consumes the daily review allowance and can't be undone
`src/store/DataContext.tsx:195-203` · _confirmed (2 votes)_

`rateCard` builds `nextDayDone = { reviews: dayDone.reviews + 1, neww: … }` **unconditionally**, then the cram branch `if (!writeSchedule) return { …prev, person:{ …prev.person, dayDone: nextDayDone } }` commits it — even though cram is advertised as "Free practice — never changes your schedule." `dayDone.reviews` gates scheduled reviews via `remainingReviews = max(0, dailyReviewLimit - done.reviews)`. Cram 20 cards with `dailyReviewLimit:20` and all genuinely-due scheduled cards disappear from every "Study N" control for the rest of the day.

**Fix:** in the `!writeSchedule` branch, return `prev` unchanged (cram must not touch `dayDone`).

### H4 — Malformed/truncated AnkiWeb response spins `parseDeck` forever, freezing the JS thread
`src/domain/ankiweb.ts:131,201` · _confirmed (2 votes)_

`parseDecksResponse` computes `const end = pos + len` with no clamp to `bytes.length`, then `parseDeck` loops `while (pos < end)`. `readVarint` can't advance past the buffer (its `while (p < bytes.length)` body never runs), so once `pos ∈ [bytes.length, end)` every iteration makes no progress and the loop never terminates. Triggered by typing a search term whose response is truncated or shaped so a `Deck` declares a length exceeding the bytes present.

**Fix:** `const end = Math.min(pos + len, bytes.length)` (and likewise for the name field), and break `parseDeck`'s loop when an iteration makes no progress (`pos` unchanged).

### H5 — CSV delimiter is chosen from a single line, corrupting headerless tab/semicolon imports
`src/domain/importFile.ts:153,414` · _confirmed (2 votes)_

`parseImportCsv` picks one delimiter for the whole file from `detectDelimiter(firstContentLine(clean))` and never validates against the rest. When the first line is a data row whose later fields contain commas (exactly why people choose TSV/semicolon), comma out-counts the real delimiter and **every** row mis-splits. Compounded by `detectDelimiter` toggling quote-state on any `"` while `splitCsvRows` only honors quotes at field start — an unbalanced `"` (inch mark, smart quote) skews detection further.

**Fix:** detect across the first N content lines, choosing the candidate that yields the most consistent column count; align quote handling between `detectDelimiter` and `splitCsvRows`.

### H6 — Every import forces `lang:'de'`, so non-German decks get a German TTS voice
`src/store/DataContext.tsx:523` · `src/app/import.tsx:174` · `src/app/card-editor.tsx:94` · `src/domain/anki.ts:192` · _confirmed (2 votes)_

`importDeck` maps cards with `lang: f.lang ?? 'de'`; the "From a file" path and the card editor's non-German/"Other" decks default to `'de'`; Anki field-role detection only recognizes English/German field names, so a Spanish/French `.apkg` is staged German. Result: French vocabulary pronounced by a German voice, and German article de-emphasis applied to non-German words.

**Fix:** thread the real source language through the import staging (let the user pick, or infer from deck/field metadata), and map the editor's deck language to a proper `Lang` code instead of defaulting to `'de'`.

---

## 🟡 Medium

| # | Issue | Location |
|---|---|---|
| M1 | **Factory-reset "Export a backup first" writes nothing** but claims success — false safety before an irreversible wipe. | `settings.tsx:588` |
| M2 | **Reviews-per-day goal stepper never updates `dailyReviewLimit`** — a raised goal is silently capped at the old limit. | `settings.tsx:69` |
| M3 | **Every rating (incl. new & learning-step cards) increments `dayDone.reviews`**, so new-card study eats the review allowance. | `DataContext.tsx:197` |
| M4 | **`deckStats.due` is capped by the global daily-review remaining**, so the "N due" urgency label undercounts real due cards once over the limit. | `queue.ts:213` |
| M5 | **Android hardware-back / app-kill mid-session discards XP, streak and the SessionRecord** while keeping schedule mutations — partial, inconsistent commit. | `session.tsx:311` |
| M6 | **Mastery/language achievements (Centurion/Scholar/Polyglot) and the streak read a pre-final-rating snapshot**, so the session that earns them unlocks them a session late. | `DataContext.tsx:301,262` |
| M7 | **`buildQueue` 'hardest'/'cram'/'ahead' cap at a hardcoded 20**, ignoring `settings.sessionLimit` — "Review hardest" over 80 weak cards serves only 20. | `queue.ts:126` |
| M8 | **Browse deck-filter leaks across navigation** into collection-scoped and full-library views, silently narrowing results. | `browse.tsx:75` |
| M9 | **Unsaved-changes guard only covers the on-screen back button**; Android hardware-back / iOS edge-swipe bypass it, losing edits. | `card-editor.tsx:153` |
| M10 | **Requeued "Again" cards show stale SM-2 interval predictions** that contradict what the rating actually applies. | `session.tsx:213` |
| M11 | **Importing an all-duplicate deck creates a phantom 0-card deck** and a dead "Study the new cards" CTA. | `import.tsx:260` |
| M12 | **Anki field-role detection is English/German-only**, so decks with field names in other languages map word/translation wrong. | `anki.ts:192` |
| M13 | **Streak-freeze economy contradicts the UI**: no 7-day milestone grants a freeze; only the one-time Quick-draw does. | `gamification.ts:125` |
| M14 | **"Keep going" hub counts span paused/inactive/orphaned decks and ignore the session cap**, so the number doesn't match what launches. | `complete.tsx:94` |
| M15 | **Debounced save swallows all errors** (quota on a large library) → silent persistence failure reported as success. | `DataContext.tsx:178` |
| M16 | **Debounced save is cleared, never flushed, on background/unmount** — the last ≤400 ms of mutations (including a completed session) is lost. | `DataContext.tsx:180` |

---

## ⚪ Low

| # | Issue | Location |
|---|---|---|
| L1 | Daily goal set to `0` → `NaN` width in Home goal bars and goal trivially "complete." | `index.tsx:409` |
| L2 | "Reset preferences to defaults" resets `settings.srs` but not `person` goals → `goalNew` desyncs from `dailyNewLimit`. | `settings.tsx:528` |
| L3 | Stats "weak cards" count includes inactive-deck cards and uses a different definition than the session it launches. | `stats.tsx:88` |
| L4 | Activity-heatmap start-date label (absolute-ms subtraction) disagrees with the heatmap's actual first column. | `stats.tsx:346` |
| L5 | Font-load error is ignored → app stuck on the splash screen forever. | `_layout.tsx:122` |
| L6 | Card delete is a single tap, no confirmation/undo — contradicts the "guarded delete" contract. | `card-editor.tsx:302` |
| L7 | Only the first unlocked achievement is celebrated; "freeze earned" text attaches to the wrong achievement. | `complete.tsx:103` |
| L8 | `autoPlayAudio` setting is a dead toggle — audio never auto-plays on reveal. | `session.tsx:181` |
| L9 | Undo doesn't reverse the fast-answer increment → inflated `fastAnswers` and Quick-draw payout. | `session.tsx:240` |
| L10 | `+10` "Daily streak" XP bonus is paid every session of the day (and on cram), not once per day. | `DataContext.tsx:284` |
| L11 | "Hard" can schedule a graduated card at/beyond the "Good" interval (grade↔interval monotonicity broken for small intervals). | `srs.ts:81` |
| L12 | Learning "Hard" persists an out-of-range `stepIndex` after the learning-steps preset is shrunk. | `srs.ts:55` |
| L13 | `displayState()` omits the `buriedUntil` check → a buried-but-overdue card is mislabeled "due" in Browse. | `types.ts:228` |
| L14 | `collectionStats` "due now" uses raw `isDue` while `deckStats` uses limit-aware counts → identical pools show different "due." | `queue.ts:241` |
| L15 | `readyOfPool` applies the global daily-review remaining to each deck-scoped pool → per-deck launch counts can sum past the aggregate. | `queue.ts:152` |
| L16 | Cloze: multi-deletion notes (c1/c2/…) collapse into one card with all blanks revealed; any field merely mentioning `{{cN::}}` triggers cloze mapping. | `anki.ts:233,236` |
| L17 | Anki imports never split German articles into article/base → article shown un-de-emphasized. | `anki.ts:286` |
| L18 | Network/apkg buffers have no size cap → an oversized or zip-bomb AnkiWeb response can OOM-crash. | `ankiweb.ts:289` |
| L19 | `levelInfo.pct` rounds up to 100% while still below the level boundary. | `gamification.ts:87` |
| L20 | Headerless CSV whose first entry is a header-like token silently drops that first card. | `importFile.ts:290,422` |
| L21 | Theme hydrates async from a 'light' default after splash hides → light-palette flash; the preference read has no `.catch` → possible unhandled rejection. | `ThemeContext.tsx:43,44` |
| L22 | AddDeckSheet flashes the language list/title during the close animation when dismissed from a deck detail level; PeekSheet/CardPeek skip the dismiss animation (vanish abruptly). | `AddDeckSheet.tsx:45`, `PeekSheet.tsx:81` |

---

## ❓ Needs confirmation (verifiers split)

- **`rate()` has no re-entrancy guard** — simultaneous/rapid taps on the final card may double-rate and double-complete the session. Uncertain because the exact RN gesture/commit timing wasn't pinned down. Worth a guard regardless (a `ratingInFlight` ref). — `session.tsx:200`
- **Cancelling during the final synchronous import write** may falsely claim "nothing was written" while the deck is actually created. — `import.tsx:290`

---

## ✅ Refuted by verification (recorded for transparency)

Six findings were killed by the adversarial pass — useful evidence the verifiers weren't rubber-stamping:

- **No schema migration / field defaulting** (`DataContext.tsx:162`) — crash sites read correctly, but a persisted doc that passes the `cards`/`person` check yet lacks newer fields can't actually arise given the stable stored shape. _Latent footgun; worth a defensive default-merge on load, but not a present bug._
- **`ready` true on hydrate-fail → seed saved** (`DataContext.tsx:170`) — same mechanism as C1; this instance's benign (first-boot) framing was correctly refuted, while the data-present path is the confirmed C1.
- **`uid()` cross-launch collision** (`DataContext.tsx:58`) — concrete collision unreachable in practice.
- **Streak resets to 1 after a 3+ day gap despite freezes** (`DataContext.tsx:275`) — accurate trace, but this is the intended freeze model (freezes bridge a single missed day, not multi-day gaps).
- **`collectionFilter('young')` admits learning cards** (`queue.ts:102`) — true but harmless for the "young" smart filter.
- **Modern-format AnkiWeb download shows an impossible "re-export from Anki" hint** (`import.tsx:273`) — message routing benign.

---

## Coverage gaps & audit limitations

- **Test coverage:** only 5 of 14 domain modules have tests. The highest-risk files are untested: `srs.ts` (scheduling engine), `gamification.ts` (XP/level/streak math), and the entire import pipeline (`importFile`, `anki`, `ankiweb`, `importApkg`). Several findings above sit precisely in those blind spots — they are invisible to CI today.
- **Round 2 did not run.** The coverage critic proposed 6 gap missions — `persist-migration`, `time-rollover` (DST/midnight-during-session), `locale-model`, `inflight-lifecycle` (delete-deck-during-active-session), `catalog-readd`, `ui-a11y-dynamic-type` — but the monthly spend limit aborted them before any executed. These remain **unexamined**, especially: timezone/DST behavior of `dayKeyOf`/`addDays` under a real session crossing local midnight, and accessibility/dynamic-type. Re-running round 2 (after raising the limit) would extend coverage there.
- **Method:** findings are reasoning-based, traced against the real code and adversarially verified, but **not yet reproduced at runtime**. Recommend converting the Critical + High items into failing tests first (especially `srs.ts`/`queue.ts`/`DataContext.tsx`, which are pure and trivially testable) before fixing.

### Suggested fix order
1. **C1** (data loss) — highest blast radius, smallest change.
2. **H2 / H3 / H6** — data-loss-class and core-correctness, all small reducer/handler fixes.
3. **H1** — pervasive new-user UX breakage; one gating change repeated across 4 files.
4. **H4 / H5** — untrusted-input hardening (clamp buffers, multi-line delimiter detection).
5. Medium cluster around daily-allowance accounting (M2/M3/M4) and persistence (M15/M16).
