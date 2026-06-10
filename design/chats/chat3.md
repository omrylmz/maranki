# Legacy Code Cleanup

_Started 2026-06-10 16:25 UTC_

---

## User

I duplicated the project to keep legacy code. Now I want you to remove all legacy components from this one. Then I want you to check all the wiring of this mockup so that we can continue with backend in Claude Code. Finally verify and make sure if we support Anki flashcard download and integration seamlessly.

## Assistant

_[tool: list_files]_

_[tool: check_design_system]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: grep]_

_[tool: update_todos]_

_[tool: read_file]_

_[tool: delete_file]_

_[tool: read_file]_

Removing the legacy v1 kit and fixing the docs that point to it:

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: read_file]_

_[tool: read_file]_

Now auditing the v2 mockup's wiring. Reading the orchestrator and key screens:

_[tool: read_file]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: grep]_

_[tool: local_grep]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: read_file]_

I accidentally dropped a style line in that edit — restoring it:

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: write_file]_

_[tool: check_design_system]_

All wiring gaps are fixed. Now writing the handoff document for Claude Code:

_[tool: str_replace_edit]_

_[tool: update_todos]_

_[tool: done]_

_[tool: fork_verifier_agent]_

Done with all three asks. Summary:

**1. Legacy removed** — deleted `ui_kits/app/` (12 files, the v1 kit); updated root `README.md` and `SKILL.md` to point at `app-v2` only. Compiler is clean (24 cards, 185 tokens, no issues).

**2. Wiring audit** — all components/exports/props check out, but I found and fixed 5 dead interactions: onboarding's "Or import your own deck" (now opens Import), launchpad's "Resume" on paused decks, the library "Sort" button, audio play buttons (session card + card peek), and the session more-sheet actions (Reschedule/Flag/Switch mode). Also removed dead state in the card editor. I wrote **`ui_kits/app-v2/WIRING.md`** — the Claude Code handoff: callback contract per screen, data shapes mapping to the repo models, the full inventory of snack-only stubs (with which repo function each maps to), and mockup-isms not to copy into prod.

**3. Anki integration** — the import hub covers the spec contract (in-app AnkiWeb search, `.apkg`/CSV auto-detect, preserved SRS scheduling, dedupe preview, cancellable, "Go study"). I added the missing piece: pasting an **AnkiWeb URL or deck ID** now surfaces an "Import from AnkiWeb" row straight to preview, plus a no-results state. One caveat, documented in WIRING.md: **error states (fetch failure/offline/parse failure) and the CSV mapping stage aren't mocked** — flagged as required backend+UI work per OPP-STATE-12. Note the spec scopes Anki as import-only; export is JSON/CSV backup, no `.apkg` export.

A verifier is double-checking the flows in the background now.

## User

No issues found

## Assistant

_[tool: update_todos]_

Verified clean — all flows pass (import via AnkiWeb ID paste, onboarding → import, resume snackbar, session loop with undo), no console errors.

The project is ready for handoff: point Claude Code at `ui_kits/app-v2/WIRING.md` first — it lists the callback contract, data shapes, the stub inventory with their matching repo functions, and the two Anki gaps to build (import error states + CSV mapping stage).

