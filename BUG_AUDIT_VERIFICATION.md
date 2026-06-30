# Maranki — Bug Audit Verification

_Adversarial verification of the `fix/bug-audit` branch against [BUG_AUDIT.md](./BUG_AUDIT.md). A multi-agent workflow spawned one verifier per enumerated finding (C1, H1–H6, M1–M16, L1–L22, NC1–NC2 = 47 items); each traced the **current** code (the audit's line numbers are pre-fix and have shifted), located the regression test, and rendered a verdict. A second adversarial pass (always for Critical/High/Needs-Confirmation, plus any Medium/Low that wasn't FIXED-with-test-and-high-confidence) tried to **refute** each verdict._

Baseline before this pass: `tsc` clean · `jest` 154/154 · `expo lint` clean.

## Result

| | Count |
|---|---|
| Verified genuinely FIXED | **39 / 47** |
| Gaps (PARTIAL / NOT_FIXED) | **8** |
| FIXED but lacking a regression test | 17 |

**C1 and 4 of 6 High items survived adversarial verification** with tests the skeptics could not break. The 8 gaps were honest *partial* fixes — the main thrust addressed, a reachable edge left.

## Gap disposition

| ID | Sev | Before | Action taken | Test |
|----|-----|--------|--------------|------|
| **H5** | High | PARTIAL | Delimiter scoring rewarded *more columns*, so a comma inside a translation list (`gehen⇥to go, to walk`) out-voted the real tab. Re-ranked on **consistency only**, tie-broken toward the rarer-in-content delimiter (tab > semicolon > comma). | ✅ `importFile.test.ts` |
| **H6** | High | PARTIAL | Language was inferred from the deck *name* only. Extended `inferLang` to recognise distinctive foreign field/header **labels** (Palabra/Traduction…) as whole tokens, and threaded CSV headers + Anki model field names into inference via `ParsedImport.fieldNames`. Also taught the CSV header detector the foreign labels. | ✅ `words.test.ts`, `importFile.test.ts` |
| **M15** | Med | PARTIAL | `persistError` was captured but had **zero consumers** (never shown). Added a pure `persistErrorMessage()` and wired it into `AppStack` → snackbar, so a failed load/save surfaces. | ✅ `persistence.test.ts` |
| **L1** | Low | PARTIAL | NaN width was fixed but a 0 goal still rendered "Daily goal complete!". Guarded `goalMet` against a 0 goal (mirrors `goalPct`). | — (screen-inline) |
| **L15** | Low | NOT_FIXED | **Kept as a documented design decision.** Each per-deck launch count honestly equals the session that deck opens; the daily limit is one shared budget and the aggregate hero is the real ceiling. The audit's literal fix (pre-divide the budget) would break the file's load-bearing "button N === session length" invariant. Pinned the intended behavior with a test instead. | ✅ `queue.test.ts` |
| **L18** | Low | PARTIAL | True streaming abort isn't reliably available on RN fetch (no readable `res.body`). Kept the existing size guards (Content-Length pre-check + post-read byteLength), **pinned them with tests**, and documented the residual (a server that both omits Content-Length and streams a >cap body could over-allocate before the post-read guard). | ✅ `ankiweb.test.ts` |
| **L22** | Low | PARTIAL | PeekSheet/CardPeek vanished abruptly (no exit animation). Retain the target/card through `Sheet`'s slide-out (`open` follows the live prop; the retained value clears on `onClosed`) — self-contained, since the parents already mount these unconditionally. | — (animation; needs device check) |
| **M5** | Med | PARTIAL | **Flagged, not changed.** Back/swipe exits already commit payout (fixed + guarded). The residual — a true process-kill mid-session drops XP/streak/SessionRecord while schedule writes survive — needs an in-progress-session marker reconciled on next boot (or per-rating payout). Committing eagerly on `AppState` background risks **double-paying** XP if the user merely backgrounds and returns. Worth doing as a device-verified lifecycle change. Note: the card *scheduling* already persists per-rating, so SRS progress is **not** lost on a kill — only the gamification/history for the interrupted session. |

## Final state

`tsc --noEmit` clean · `jest` **166/166** (+12) · `expo lint` clean.

## Remaining coverage opportunity (not defects)

17 items verified FIXED carry no regression test — correct today, unguarded tomorrow. Most are React-screen handlers (M2, M6, M8, M9, L2, L4–L9, NC1–NC2) that need component-level tests; M1/M11/M16 are testable at the store seam. These are coverage debt, not bugs.

## Not yet done

- **M5** — device-verified session-lifecycle work (above).
- **Device/emulator verification** of every fix — the audit and this pass are both static; nothing here has been exercised on a device.
