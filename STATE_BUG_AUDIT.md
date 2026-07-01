# Maranki — State-Bug Audit

This audit targeted **state-management defects only** (stale closures, async/boot ordering, lifecycle/reset gaps, derived-state desync, persistence integrity, and component/context state) in the code that already ships the ~32 fixes recorded in `BUG_AUDIT.md`. Every finding below is either a genuinely new state bug or concrete evidence that a claimed fix (C1, M5, M8, M16, L9) is incomplete or introduced a regression; none re-report a fixed item as-is. Each was independently traced and adversarially verified against the code on disk. After de-duplicating by root cause (the two boot-reconciler findings collapse into one), **7 distinct defects** remain, plus one router-timing item that needs runtime confirmation.

> **Fix status (branch `fix/bug-audit`).** All 7 confirmed defects are fixed in this branch; `tsc`, `jest` (172 tests, incl. new cross-midnight attribution cases in `tally.test.ts`), and `expo lint` are green. The Medium cluster (#2/#3, plus half of #4) is closed by one mechanism: a session-start `studyDay` threaded through `completeSession` and persisted in the `InProgressSession` marker (`attributionDay` in `tally.ts`). #4/#6/#7 are fixed together in `session.tsx`'s `undo()`. The **U1** router-timing item is left open pending emulator confirmation. Component-level fixes (#1, #4, #5, #6, #7) are verified by type-check + reading rather than render tests, since the suite has no React-render harness.

## Severity summary

| Severity | Distinct defects |
|---|---|
| Critical | 0 |
| High | 1 |
| Medium | 3 |
| Low | 3 |
| **Total** | **7** |

| # | Severity | Defect | Anchor |
|---|---|---|---|
| 1 | High | Background/unmount `flushSave` isn't gated on `ready` → boot-time background overwrites saved data with the blank seed | `DataContext.tsx:215` |
| 2 | Medium | A session crossing local midnight mis-attributes the study day → burns a freeze or resets the streak | `DataContext.tsx:330` |
| 3 | Medium | Boot reconciler banks an interrupted session against the reopen day, not the study day | `DataContext.tsx:463` |
| 4 | Medium | Undo leaves the persisted in-flight marker stale → reconciler banks a phantom / over-counted session | `session.tsx:313` |
| 5 | Low | Browse multi-select (`selecting`/`sel`) is never reset on deck-scope change → bulk actions hit off-screen cards | `browse.tsx:64` |
| 6 | Low | Bury-then-undo reintroduces the buried card into the session while `buriedUntil` stays set | `session.tsx:345` |
| 7 | Low | Undo never reverts `bestRun` → undone run still pays the run-bonus XP and misrecords the session | `session.tsx:321` |

> **Note on the Medium cluster (#2 and #3).** Both stem from one underlying weakness: `completeSession` derives the entire session's study-day from its *own call-time* clock (`today = dayKeyOf(Date.now())` at `DataContext.tsx:323-324`), which feeds `rollStreak`, `lastStudyDay`, and `SessionRecord.dayKey`. #2 exercises this on the live path (minutes late, across midnight); #3 exercises it on the reconcile path (hours/days late). They are kept separate because their triggers and fixes differ, but a single change — thread the true study-time day into `completeSession` and persist it in the `InProgressSession` marker — resolves both.

---

## 1. High — Background/unmount `flushSave` isn't gated on `ready`, so backgrounding during initial load overwrites saved data with the blank seed

**Location:** `src/store/DataContext.tsx:214-223` (`flushSave`), `:242-250` (AppState/unmount flush), contrast `:226` (debounced save gate). Anchor `:215`.

**Failure scenario.** An existing user with saved data cold-launches. While the splash is up and `AsyncStorage.getItem(STORAGE_KEY)` (line 179) is still in flight (window is widest for a large library), the user swipes to the app switcher or a call arrives → AppState fires `'inactive'`/`'background'` (line 244) → `flushSave()` runs. Its only guard is `if (!canSaveRef.current) return;` (line 215); `canSaveRef` is still `true` (it flips `false` only on a *read rejection* at line 197, which hasn't happened yet), so the guard passes and it writes `serialize(stateRef.current)` — the blank `buildSeedState()` — to `STORAGE_KEY`. `getItem` then resolves with the real bytes (read before the overwrite), so in-memory state looks fine and nothing signals damage. The OS reclaims the backgrounded process. Next cold launch, `getItem` returns the seed, `classifyStored` passes `isValidState` on the empty-but-valid arrays → `'loaded'`, so no corrupt branch and no `BACKUP_KEY` copy: every deck, card, session, streak and XP is **permanently lost**.

**Why it's a state bug.** Persistence integrity — in-memory vs AsyncStorage divergence. The debounced save effect correctly guards both conditions (`if (!ready || !canSaveRef.current) return;`, line 226), but the M16 flush path (added so the last ≤400 ms of a finished session isn't dropped on suspend) bypasses the `ready` gate entirely. During the load window `state`/`stateRef.current` are still the seed and `ready` is `false`, so a mundane background/unmount event clobbers intact stored data with the seed. This defeats C1's stated invariant ("a transient error can't overwrite intact stored data") through the exact boot window C1's gate does not cover — a regression introduced by the M16 flush.

**Fix.** Gate `flushSave` on `ready` as well as `canSaveRef`. Because `flushSave` is a `useCallback([])`, mirror `ready` into a ref (as `stateRef` mirrors `state`) and early-return: `if (!readyRef.current || !canSaveRef.current) return;`. This makes the flush path honor the same write-gate as the debounced save, so no write can land before the initial read has classified the stored blob.

---

## 2. Medium — A study session spanning local midnight mis-attributes the study day, burning a freeze or resetting the streak

**Location:** `src/store/DataContext.tsx:323-324` (`now`/`today` from completion instant), `:330` (`rollStreak(person, today)`), `:430` (`lastStudyDay: today`); per-rating tally in `rateCard` at `:256`, `:261-262`; `rollStreak` branch logic in `src/store/tally.ts:64-71`. Anchor `DataContext.tsx:330`.

**Failure scenario.** `person.streak = 10`, `freezes = 0`, `lastStudyDay = '2026-06-29'` (every day 20–29 studied and completed before local midnight). On 2026-06-30 the user's only session runs 23:58 → 00:01: the ratings at 23:58/23:59 tally `dayDone` under `'2026-06-30'` (each `rateCard` uses its own `Date.now()`), but `completeSession` fires at 00:01, so `today = '2026-07-01'`. `rollStreak` compares `lastStudyDay('2026-06-29')` against `yesterday('2026-06-30')` and `dayBefore('2026-06-29')`: with `freezes = 0` neither the `+1` (line 64) nor the freeze-bridge (line 66) branch matches, so it falls to `streak = 1` (line 71) — **a 10-day streak is wiped** even though the user studied every consecutive calendar day (`dayDone` recorded the 30th). In the `freezes = 1` variant the freeze-bridge branch instead **burns the freeze** (1→0) and pushes `'2026-06-30'` — a day the user demonstrably studied — into `freezeUsedDays`, which the stats strip then renders as a snow/missed day.

**Why it's a state bug.** Derived-state desync across a time-rollover boundary. `lastStudyDay` and the streak are derived from the session's *end* instant, while `dayDone` is tallied per rating from each rating's instant; the two "when did you study" signals diverge whenever a session crosses midnight, and `rollStreak` never consults `dayDone`, so the tally that correctly recorded the pre-midnight study is ignored. This is exactly the "midnight-during-session" case `BUG_AUDIT.md:178` lists as UNEXAMINED (the round-2 time-rollover mission never ran); it is distinct from the refuted 3-day-gap item (`BUG_AUDIT.md:169`) because here there is no real gap — it is a phantom gap manufactured by completion-time attribution.

**Fix.** Attribute the session to the day the reviews actually happened, not the completion instant. Thread a study-day into `completeSession` (e.g. the `dayKeyOf` of the last committed rating, or the session-start day captured in `session.tsx`) and use it for `rollStreak`, `lastStudyDay`, and `SessionRecord.dayKey`, instead of `dayKeyOf(Date.now())`. This also fixes defect #3 when combined with persisting that day in the marker.

---

## 3. Medium — Boot reconciler banks an interrupted session against the reopen day, not the study day

**Location:** `src/store/DataContext.tsx:458-466` (one-shot reconciler), `:322-324`/`:330`/`:350-351`/`:430` (`completeSession` time attribution); marker shape at `src/domain/types.ts:163-171` (no timestamp). Anchor `:463`. *(Merges the two independently-reported boot-reconciler findings — same root cause, same lines.)*

**Failure scenario.** 2026-06-29 (Mon) 08:00: the user finishes a session, so `person.streak = 5`, `lastStudyDay = '2026-06-29'`. 23:55 the same night: the user starts a second session and rates a few cards — each non-final rating calls `actions.trackSession(...)` (`session.tsx:299-307`), persisting an `inProgressSession` marker — then the phone locks (AppState `'background'` → `flushSave` writes the marker) and the OS kills the app overnight (a process kill fires no navigation `beforeRemove`, so the marker is never cleared). 2026-06-30 (Tue) 07:00: the user reopens. Load restores the marker plus `streak = 5`/`lastStudyDay = '2026-06-29'`; once `ready` flips true the reconciler reads `stateRef.current.inProgressSession` and calls `completeSession(marker)` with `now = Tue 07:00`. `rollStreak` sees `lastStudyDay === yesterday`, so `streak → 6`, `advanced = true`, `lastStudyDay → '2026-06-30'`, the `SessionRecord` is dated Tuesday, and the +10 daily-streak XP is paid for Tuesday — even though the user has done **zero reviews on Tuesday**; Monday-night's session props up an unstudied calendar day. The persisted state is internally inconsistent: the `reviewLog` entries for those reviews carry `atMs` on Monday (written by `rateCard` that night) while the `SessionRecord` claims Tuesday. Reopening two days later banks the same session under that far-later day and can spuriously consume a freeze to bridge the invented gap.

**Why it's a state bug.** Persistence + transition. The reconcile effect replays a persisted snapshot through `completeSession`, which reads the reboot-time `now`/`today` for the streak roll, `lastStudyDay`, and `SessionRecord.dayKey`. The `InProgressSession` snapshot deliberately omits its original day (only `kind`/`label`/`counts`/`total`/`bestRun`/`durationSec`/`fastAnswers`), so there is no committed field to reconcile against and the session's day is silently rewritten to the reopen day. Boot ordering is not the culprit: the `stateRef`-sync effect (line 171) is declared before the reconciler (line 458), so the marker is reliably mirrored before it runs — the bug is that the marker carries no day.

**Fix.** Persist the study-time day (or the timestamp of the first/last rating) inside the `InProgressSession` marker when `trackSession` writes it, and have the reconcile path pass that day into `completeSession` rather than letting it default to `Date.now()`. Combined with defect #2's fix (a `completeSession` that accepts an explicit study-day), the reconciler credits the session to the night it happened.

---

## 4. Medium — Undo leaves the persisted in-flight marker stale, so the boot reconciler banks a phantom / over-counted session

**Location:** `src/app/session.tsx:299-307` (`trackSession` written on every non-final rating — its only caller), `:313-325` (`undo`, which never updates or clears the marker); reconcile consumer at `src/store/DataContext.tsx:458-466`. Anchor `session.tsx:313`.

**Failure scenario.** Start a session with ≥2 cards. Rate card 1 Good → `rate()` takes the non-final branch and calls `trackSession({ total: 1, counts: { good: 1 }, ... })`; the marker is set and, within the 400 ms debounce (or a background flush), persisted. Tap Undo → `undoLastReview()` empties the `reviewLog`, sets `dayDone.reviews` back to 0, and restores card 1 to `reps: 0`; the local UI returns to `idx 0` with `counts.good = 0` — but `inProgressSession` is left untouched at `{ total: 1, good: 1 }`. Undo's `setState` triggers a save that persists this internally-inconsistent blob (marker says 1, `reviewLog` is empty). Close the screen (with `reviewed === 0` the `beforeRemove` listener early-returns, so nothing clears the marker) or let the OS kill the backgrounded app. On next launch the reconciler calls `completeSession(marker)`, minting a 1-card / 1-Good `SessionRecord` and paying its XP (≥4) even though **zero cards were actually reviewed**: `person.xp` inflates and `state.sessions` gains a `total: 1` entry that contradicts `dayDone.reviews = 0`, an empty `reviewLog`, and the card's `reps: 0`. With N ratings then N undos before the exit/kill, the over-count grows by the whole undone tail.

**Why it's a state bug.** Persistence + reset. A local revert (undo) is not mirrored into the persisted crash-recovery snapshot, so the boot reconciler restores a stale, higher count — the derived `SessionRecord`/XP desync from the source of truth (`reviewLog`/`cards`/`dayDone`, all correctly reverted). `trackSession` has exactly one caller (`rate`), so no path ever refreshes the marker after an undo. This is an incompleteness in the M5 crash-recovery fix, which added the marker but did not keep it consistent under undo.

**Fix.** In `undo()`, mirror the revert into the marker: call `actions.trackSession(...)` with the reverted `counts`/`total`, or clear the marker (`trackSession(null)` / a dedicated clear action) when `reviewed` drops to 0. That keeps the persisted recovery snapshot consistent with `reviewLog`/`dayDone` so the reconciler can't bank undone reviews.

---

## 5. Low — Browse multi-select is never reset when the deck scope changes, so bulk actions target off-screen cards

**Location:** `src/app/(tabs)/browse.tsx:63-64` (`selecting`/`sel`), `:76-79` (navigation effect resets only `fDecks`), `:118-123` (`bulk` uses `sel`), `:125-130` (`studySelected`); mutation site `src/store/DataContext.tsx:470-476` (`setCardProps`, no scope validation). Anchor `browse.tsx:64`.

**Failure scenario.** Browse is scoped to deck X (peek deck X → "Browse cards" sets `params.deckId = X`, effect sets `fDecks = [X]`). Tap "Select" and check 3 cards → `selecting = true`, `sel = [x1, x2, x3]`, the bulk bar reads "3". Switch to the Study tab (Browse is frozen-but-mounted via `freezeOnBlur`, so `selecting`/`sel` are retained), peek deck Y → "Browse cards" → `router.push('/(tabs)/browse', { deckId: Y })`. The effect at line 76 fires on the `params.deckId` change and resets `fDecks = [Y]`, but nothing resets `selecting` or `sel`. Browse now lists deck-Y cards with no checkmarks, while the bulk bar still reads "3". Tapping the heart runs `setCardProps([x1, x2, x3], { fav: true })` — favoriting three **off-screen deck-X cards**; suspend removes those invisible deck-X cards from the studiable pool; "Study these" launches a session over off-screen deck-X cards.

**Why it's a state bug.** Lifecycle/reset. Local selection state describing one entity set (deck X's cards) is not reset when the scope/entity it describes changes on navigation, leaving it desynced from the visible card set. The reset points for `selecting`/`sel` are only `bulk`, `studySelected`, the Cancel button, and `Select` — there is no focus/param-driven reset. This is distinct from M8 (which fixed only the `fDecks` leak); the M8 fix's persistence of the Browse instance across navigation is exactly what retains `selecting`/`sel`.

**Fix.** In the same navigation effect that resets `fDecks` (line 76-79), also clear the selection when the scope changes: `setSelecting(false); setSel([]);`. Alternatively key the reset on any `params.deckId`/`params.collectionId` change so a scope switch always exits select mode.

---

## 6. Low — Burying a card then pressing undo reintroduces it into the session while `buriedUntil` stays set

**Location:** `src/app/session.tsx:345-358` (`bury` — mutates the store and rebuilds the local queue but pushes no history entry), `:313-325` (`undo` — restores the pre-bury queue snapshot); store mutation `src/store/DataContext.tsx:478-487` (`buryCard`, sets `buriedUntil`, adds no reviewLog entry). Anchor `session.tsx:345`.

**Failure scenario.** Scheduled session, queue `[A, B, C]`. Rate A Good → `history = [snap{queue:[A,B,C], idx:0}]`, `idx = 1`, card = B. Open the "…" sheet on B and tap "Bury for now" → the store sets `B.buriedUntil = tomorrow` and the local queue becomes `[A, C]`, but `history` is unchanged (bury never snapshots). Tap Undo (still enabled, `history.length === 1`): `undo()` restores `prev.queue = [A, B, C]` and calls `undoLastReview()`, which reverts only A's rating (the last `reviewLog` entry; bury added none). **B is now back in the active queue at `idx 1` while `store.cards[B].buriedUntil` is still tomorrow.** Re-rating A advances to B, which is shown and studiable in-session, yet every other surface (`readyOfPool`, `queue.ts`) still treats B as buried; `applyRating` spreads `...card` and never clears `buriedUntil`, so even re-rating B in-session leaves it buried elsewhere. Exiting before reaching B leaves B buried all day with no un-bury path.

**Why it's a state bug.** Snapshot-vs-committed divergence. A committed store mutation (bury) is performed with no corresponding local-history snapshot, so a later undo restores a stale local queue that no longer matches the committed card state; the session and store diverge with no reconciliation.

**Fix.** Make bury undoable and consistent: either push a history entry when burying (recording enough to restore both the queue and the store's `buriedUntil` on undo), or disable/omit the buried card from undo restoration so the local queue can't reintroduce a card the store has buried. Simplest is to have `undo()` reconcile the restored queue against current `buriedUntil` (drop cards the store now buries), and to have bury clear cleanly if undone.

---

## 7. Low — Undo never reverts `bestRun`, so an undone in-session run still pays the run-bonus XP and misrecords the session

**Location:** `src/app/session.tsx:40-49` (`Snapshot` interface omits `bestRun`), `:272`/`:285` (`setBestRun(Math.max(bestRun, nextRun))` — monotonic), `:313-325` (`undo` restores `run` but never `bestRun`); consumers `src/store/DataContext.tsx:338-343` (`sessionXpItems` run bonus), `:355` (`SessionRecord.bestRun`). Anchor `session.tsx:321`.

**Failure scenario.** Start a 6-card session. Rate the first 5 cards Good — `run` climbs 1..5, `bestRun = 5`, the "5 in a row" milestone shows, `idx = 5`. Tap Undo: it restores `run` to 4 and `idx` to 4 but leaves `bestRun = 5` (a running max that no undo can lower). Tap close → End session. `completeSession` is called with `total = reviewed = 4` but `bestRun = 5` (a run of 5 is impossible in a 4-card session). Result: the user is granted the +8 run-bonus XP they didn't earn (`RUN_BONUS_MIN = 5`), the payout screen shows "5 in a row," and `SessionRecord.bestRun` is persisted as 5 with `total = 4`.

**Why it's a state bug.** Reset/mirror. An undo transition fails to revert a derived mirror (`bestRun`) that other state (XP payout, `SessionRecord`) is computed from; the run-streak sub-machine only ever moves up. This is the same class as the audit's L9 (undo not reverting `fastAnswers`), which was fixed by adding `fastAnswers` to `Snapshot` — the sibling `bestRun` field was overlooked, so the L9 fix is incomplete.

**Fix.** Capture `bestRun` in the `Snapshot` interface (line 40-49) alongside `run`/`fastAnswers`, and restore it in `undo()` via `setBestRun(prev.bestRun)`, exactly as L9 did for `fastAnswers`.

---

## Uncertain (timing-dependent, needs runtime confirmation)

### U1 — Browse deck-scope reset fires only on a `params.deckId` value-change, so same-value re-entry keeps a stale/overridden filter (M8 fix possibly incomplete)

**Location:** `src/app/(tabs)/browse.tsx:76-79`. Anchor `:78`.

The M8 fix resets the deck filter via `useEffect(() => setFDecks(params.deckId ? [params.deckId] : []), [params.deckId])`, and its comment claims it clears the scope when navigating to the full library or a collection. But the effect is keyed purely on the *value* of `params.deckId` (React re-runs only on `Object.is` change). Two re-entry paths don't change the value and so never re-run the reset: (a) after `router.push('/(tabs)/browse', { deckId: X })`, later tapping the Browse tab-bar icon re-focuses the same route with `params.deckId` still `X`, keeping the view locked to deck X when the user expects the library; (b) if the user then manually edits the filter to deck Y (`fDecks = [Y]`) and re-navigates to "Browse cards" for the *same* deck X, `params.deckId` is X→X (unchanged), so `fDecks` stays `[Y]` and they see deck Y though they asked for X. Whether a given re-entry clears the scope depends on expo-router's tab/param retention rather than on intent.

**Why uncertain.** Confirming either path requires running the app on device/emulator to verify that expo-router does *not* remount `BrowseScreen` or reset its params on a same-value re-push (a remount would reset `fDecks` to `[]` and mask the bug). The freeze-on-blur behavior makes a persisted single instance likely (consistent with M8 having been a real leak), but this is exactly the router lifecycle detail that reasoning alone cannot pin down. If confirmed, the fix is to reset on any navigation to Browse (e.g. a `useFocusEffect`, or keying on a nav-instance/`key` param) rather than only on a changed `params.deckId`.
