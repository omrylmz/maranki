#!/usr/bin/env bash
#
# generate-state-fixtures.sh — make the saved-state fixtures in
# src/store/__fixtures__/ by RUNNING THE OLD CODE (spec W0-1; this replaces the
# emulator capture of `capture-state-fixture.sh` in the spec).
#
# WHY: the migration tests (wave 1+) must read documents that old builds really
# wrote, not documents we imagine. So for each old build this script:
#   1. checks out the old commit in a temporary, detached git worktree,
#   2. links this repo's node_modules into it (the old package.json files ask
#      for the same Expo SDK 56 packages, so the current install runs them),
#   3. writes a TEMPORARY jest test into it. The test renders that build's real
#      <DataProvider> (react-test-renderer + the AsyncStorage jest mock + fake
#      timers) and calls the same store actions the old screens call, in the
#      same order (onboarding, add decks, import, favorite, flag, study),
#   4. copies the string the old DataProvider saved under `maranki.state.v1`
#      (that build's own serialize()) BYTE FOR BYTE into the fixture file,
#   5. removes the temporary worktree.
# Then it derives three edge-case fixtures from the v1 fixture (see the README).
#
# The content is synthetic: curated catalog words, a made-up CSV, and the
# made-up Anki fixtures (src/domain/__fixtures__/anki). No personal data. By
# default the input and the output are made up, so the result is safe to commit.
# NEVER copy real samples into src/: this repo is public. To use real samples,
# set ANKI_DIR and OUT_DIR (below) to folders git ignores, then run
# scripts/make-synthetic-fixtures.py (RELEASING.md, "Test fixtures").
# The fake clock and TZ=UTC make every run produce the same bytes.
#
# USAGE
#   scripts/generate-state-fixtures.sh [all|v202|fork|main|derived] [--keep]
#     all      (default) every step below, in order
#     v202     v0-v2.0.2.json + v0-empty-library.json   (tag v2.0.2)
#     fork     v0-german-fork.json                      ($FORK_REPO at $FORK_REF)
#     main     v1-main-1333d48.json                     (commit 1333d48)
#     derived  v1-marker-no-studyDay.json, v1-orphan-card.json, v1-nan-fields.json
#     --keep   keep the temporary worktrees (for debugging)
#
# ENVIRONMENT
#   FORK_REPO  the old German fork    (needed by `fork` and `all`; no default)
#   FORK_REF   the fork commit        (needed by `fork` and `all`; no default)
#   ANKI_DIR   absolute path of the Anki samples (default: the made-up ones)
#   OUT_DIR    absolute path of the output       (default: the repo's fixtures)
#   SCRATCH    where temporary worktrees go (default: a new temp folder)
#
# NEEDS: git, node and ./node_modules (npm ci).
# Nothing is committed in any repo; the fork only gets a temporary worktree.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${OUT_DIR:-$REPO/src/store/__fixtures__}"
ANKI_DIR="${ANKI_DIR:-$REPO/src/domain/__fixtures__/anki}"
# The output holds the text of its samples. So a run on other samples must write
# outside the repo, or into a folder git ignores. pwd -P gives one spelling of a path.
mkdir -p "$OUT_DIR"
if [ "$(cd "$ANKI_DIR" && pwd -P)" != "$(cd "$REPO/src/domain/__fixtures__/anki" && pwd -P)" ]; then
  OUT_REAL="$(cd "$OUT_DIR" && pwd -P)"
  case "$OUT_REAL/" in
    "$(cd "$REPO" && pwd -P)"/*)
      if ! git -C "$REPO" check-ignore -q "$OUT_REAL"; then
        echo "ANKI_DIR is not the repo's made-up samples, so OUT_DIR must be a folder git ignores." >&2
        exit 2
      fi
      ;;
  esac
fi
FORK_REPO="${FORK_REPO:-}"
FORK_REF="${FORK_REF:-}"
V202_REF="v2.0.2"
MAIN_REF="1333d48"
STEP="all"
KEEP=0
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    all | v202 | fork | main | derived) STEP="$arg" ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done
if { [ "$STEP" = all ] || [ "$STEP" = fork ]; } && { [ -z "$FORK_REPO" ] || [ -z "$FORK_REF" ]; }; then
  echo "The '$STEP' step needs FORK_REPO and FORK_REF: the path and commit of the old German fork." >&2
  exit 2
fi

SCRATCH="${SCRATCH:-$(mktemp -d "${TMPDIR:-/tmp}/maranki-fixtures.XXXXXX")}"
mkdir -p "$SCRATCH" "$OUT_DIR"

if [ ! -d "$REPO/node_modules" ]; then
  echo "node_modules is missing: run 'npm ci' first" >&2
  exit 1
fi

# --------------------------------------------------------------- worktrees

# add_worktree <git dir> <ref> <folder>
add_worktree() {
  local git_dir="$1" ref="$2" dir="$3"
  rm -rf "$dir"
  git -C "$git_dir" worktree add --detach --force "$dir" "$ref" >/dev/null
  ln -s "$REPO/node_modules" "$dir/node_modules"
  mkdir -p "$dir/src/__fixturegen__"
  write_harness "$dir/src/__fixturegen__/harness.ts"
}

# remove_worktree <git dir> <folder>
remove_worktree() {
  local git_dir="$1" dir="$2"
  if [ "$KEEP" = 1 ]; then
    echo "  kept worktree: $dir"
    return
  fi
  rm -f "$dir/node_modules"
  git -C "$git_dir" worktree remove --force "$dir"
  git -C "$git_dir" worktree prune
}

# run_gen <folder> <test file> <fixture out>
run_gen() {
  local dir="$1" test_file="$2" out="$3"
  (
    cd "$dir"
    TZ=UTC FIXTURE_OUT="$out" ANKI_DIR="$ANKI_DIR" \
      npx jest --ci --no-watchman --runTestsByPath "$test_file"
  )
  echo "  wrote $(basename "$out") ($(wc -c <"$out" | tr -d ' ') bytes)"
}

need_anki_fixtures() {
  for name in german_verbs german_grammar algo_patterns; do
    if [ ! -f "$ANKI_DIR/$name.json" ]; then
      echo "missing $ANKI_DIR/$name.json" >&2
      exit 1
    fi
  done
}

# ------------------------------------------------- shared temporary harness

write_harness() {
  cat >"$1" <<'TS'
/**
 * TEMPORARY fixture-generator harness, written by
 * scripts/generate-state-fixtures.sh into an OLD checkout. Never committed.
 *
 * It renders the old build's real <DataProvider> and drives it the way the old
 * screens did. Time is a jest fake clock, so ids and dates are reproducible.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as fs from 'fs';
import * as path from 'path';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export const STORAGE_KEY = 'maranki.state.v1';
/** Longer than the 400 ms save debounce of every old build. */
export const SAVE_SETTLE_MS = 500;
/** session.tsx: a reveal → rate faster than this counts as a "fast answer". */
const FAST_ANSWER_MS = 3000;

export type Box = { current: any };
export type Rating = 'again' | 'hard' | 'good' | 'easy';

/** Mount <DataProvider> and wait until its first load finished. */
export async function boot(DataProvider: any, useData: () => any): Promise<Box> {
  const box: Box = { current: null };
  function Probe() {
    box.current = useData();
    return null;
  }
  await act(async () => {
    TestRenderer.create(React.createElement(DataProvider, null, React.createElement(Probe)));
  });
  await act(async () => {});
  if (!box.current || !box.current.ready) throw new Error('DataProvider did not become ready');
  return box;
}

/** One user tap: run the handler body, then let React commit. */
export async function tap<T>(fn: () => T): Promise<T> {
  let out: T | undefined;
  await act(async () => {
    out = fn();
  });
  return out as T;
}

/** Let time pass on the fake clock (this also fires the debounced save). */
export async function pass(ms: number): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
  await act(async () => {});
}

/** Jump the clock to a later moment (e.g. the next morning). */
export async function jumpTo(ms: number): Promise<void> {
  await pass(SAVE_SETTLE_MS);
  jest.setSystemTime(ms);
}

/** Let the last debounced save land, then copy the saved document, byte for byte, to $FIXTURE_OUT. */
export async function writeStored(): Promise<any> {
  await pass(SAVE_SETTLE_MS);
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  if (!raw) throw new Error('the old DataProvider saved nothing');
  const out = process.env.FIXTURE_OUT;
  if (!out) throw new Error('FIXTURE_OUT is not set');
  fs.writeFileSync(out, raw, 'utf8');
  return JSON.parse(raw);
}

export function readAnkiFixture(name: string): any {
  const dir = process.env.ANKI_DIR;
  if (!dir) throw new Error('ANKI_DIR is not set');
  return JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8'));
}

/**
 * The PURE half of the old parseApkg (src/domain/importApkg.ts): the old build
 * read these rows with expo-sqlite; here they come from the Anki fixture,
 * which holds the same rows. parseDeckNames / parseDeckMap are private in
 * importApkg.ts, so their few lines are repeated here unchanged.
 */
export function parseFixtureApkg(
  fixture: any,
  anki: { parseAnkiModels: any; groupNotesBySection: any; ankiDeckName: any },
  deckNameFromFile: (fileName: string) => string,
) {
  const models = anki.parseAnkiModels(fixture.col.models ?? '{}');
  const rawDecks = JSON.parse(fixture.col.decks ?? '{}') as Record<string, { name?: string }>;
  const deckNames = Object.keys(rawDecks)
    .map((k) => rawDecks[k]?.name)
    .filter((n): n is string => typeof n === 'string');
  const deckMap: Record<string, string> = {};
  for (const did of Object.keys(rawDecks)) {
    const name = rawDecks[did]?.name;
    if (typeof name === 'string') deckMap[did] = name;
  }
  // SELECT cast(id as text) as id, cast(mid as text) as mid, flds, tags FROM notes
  const rows = fixture.notes.map((n: any) => ({
    id: String(n.id),
    mid: String(n.mid),
    flds: n.flds,
    tags: n.tags,
  }));
  // SELECT cast(nid as text), cast(did as text), cast(odid as text), ord FROM cards ORDER BY nid, ord
  const cardRows = fixture.cards
    .map((c: any) => ({ nid: String(c.nid), did: String(c.did), odid: String(c.odid), ord: c.ord }))
    .sort((a: any, b: any) => (a.nid < b.nid ? -1 : a.nid > b.nid ? 1 : a.ord - b.ord));
  const noteDid: Record<string, string> = {};
  for (const r of cardRows) {
    if (noteDid[r.nid] === undefined) noteDid[r.nid] = r.odid && r.odid !== '0' ? r.odid : r.did;
  }
  const grouped = anki.groupNotesBySection(rows, noteDid, deckMap, models);
  const name = anki.ankiDeckName(deckNames, deckNameFromFile(fixture.fileName));
  const fieldNames = Object.keys(models)
    .flatMap((mid) => models[mid].flds)
    .filter((f: string) => f !== '');
  return { payload: grouped.payload, sections: grouped.sections, name, fieldNames };
}

export interface SessionScript {
  /** The queue session.tsx built once, at mount. */
  queue: any[];
  kind: string;
  label: string;
  /** Each rating, with the time spent before the reveal and before the rating. */
  ratings: { r: Rating; thinkMs: number; answerMs: number }[];
  /** 'exit' = the close button (partial session is banked); 'kill' = force-stop. */
  end: 'exit' | 'kill';
  /** Builds from 899a1d6 on (fork, main) pass the session's start day. */
  withStudyDay: boolean;
  applyRating: (card: any, r: Rating, srs: any, now: number) => any;
  dayKeyOf: (ms: number) => string;
}

/**
 * Replays session.tsx's rate() / exitNow() for one session: rateCard +
 * trackSession in one handler per rating, the "again" re-queue, run / bestRun,
 * fast answers, and the partial completion on exit.
 */
export async function studySession(box: Box, s: SessionScript): Promise<void> {
  const startedAt = Date.now();
  const day = s.withStudyDay ? { studyDay: s.dayKeyOf(startedAt) } : {};
  const srs = box.current.state.settings.srs;
  let queue = s.queue.slice();
  let idx = 0;
  let counts: Record<Rating, number> = { again: 0, hard: 0, good: 0, easy: 0 };
  let run = 0;
  let bestRun = 0;
  let fast = 0;
  for (const step of s.ratings) {
    const card = queue[idx];
    if (!card) throw new Error('the session queue ran out');
    await pass(step.thinkMs);
    const revealedAt = Date.now();
    await pass(step.answerMs);
    if (Date.now() - revealedAt < FAST_ANSWER_MS) fast += 1;
    const nextCounts = { ...counts, [step.r]: counts[step.r] + 1 };
    if (step.r === 'again') {
      queue = [...queue];
      const at = Math.min(idx + 3, queue.length);
      queue.splice(at, 0, { ...s.applyRating(card, 'again', srs, Date.now()), requeued: true });
    }
    run = step.r === 'again' ? 0 : run + 1;
    bestRun = Math.max(bestRun, run);
    if (idx + 1 >= queue.length) throw new Error('the script must not finish the queue');
    const snapshot = {
      kind: s.kind,
      label: s.label,
      counts: nextCounts,
      total: idx + 1,
      bestRun,
      durationSec: Math.round((Date.now() - startedAt) / 1000),
      fastAnswers: fast,
      ...day,
    };
    await tap(() => {
      box.current.actions.rateCard(card.id, step.r, { writeSchedule: true });
      box.current.actions.trackSession(snapshot);
    });
    counts = nextCounts;
    idx += 1;
  }
  if (s.end === 'exit') {
    await pass(2_000);
    await tap(() => {
      box.current.actions.completeSession({
        kind: s.kind,
        label: s.label,
        counts,
        total: idx,
        bestRun,
        durationSec: Math.round((Date.now() - startedAt) / 1000),
        fastAnswers: fast,
        ...day,
      });
      box.current.actions.clearLastCompletion();
    });
  }
  // 'kill': nothing else runs. The debounced save of the last rating lands
  // first, then the OS stops the app — the marker stays on disk (M5).
  await pass(SAVE_SETTLE_MS);
}
TS
}

# ------------------------------------------------------------ v2.0.2 (v0)

gen_v202() {
  local dir="$SCRATCH/old-v202"
  echo "== v2.0.2 ($V202_REF)"
  add_worktree "$REPO" "$V202_REF" "$dir"

  cat >"$dir/src/__fixturegen__/library.test.ts" <<'TS'
/** TEMPORARY: v2.0.2 user with a small library and a killed session → v0-v2.0.2.json */
import { CURATED_LANGUAGES } from '../domain/deckCatalog';
import { parseImportCsv } from '../domain/importFile';
import { buildQueue } from '../domain/queue';
import { applyRating } from '../domain/srs';
import { dayKeyOf } from '../domain/types';
import { inferLang, LANG_FLAGS } from '../domain/words';
import { DataProvider, normalizedDayDone, useData } from '../store/DataContext';
import { boot, jumpTo, pass, studySession, tap, writeStored } from './harness';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const DAY1 = Date.UTC(2026, 6, 6, 7, 30); // Mon 6 Jul 2026, 07:30
const DAY2 = Date.UTC(2026, 6, 7, 8, 10); // Tue 7 Jul 2026, 08:10

// Positional v2.0.2 columns: word, tr, ex, level, type, ipa, tags…
const CSV = [
  'Palabra,Traducción,Ejemplo,Nivel,Tipo,IPA,Etiquetas',
  'la cuchara,the spoon,Necesito una cuchara limpia.,A1,sustantivo,/kuˈt͡ʃaɾa/,cocina',
  'el tenedor,the fork,El tenedor está en la mesa.,A1,sustantivo,/teneˈðoɾ/,cocina',
  'hervir,to boil,Hay que hervir el agua.,A2,verbo,/eɾˈβiɾ/,cocina',
  'la sartén,the frying pan,La sartén está caliente.,A2,noun,/saɾˈten/,cocina',
  'picante,spicy,"Esta salsa es muy picante, ¿no?",B1,adj,,cocina|sabor',
  'probar,to taste; to try,¿Quieres probar la sopa?,A2,verb,/pɾoˈβaɾ/,',
].join('\n');

function sessionQueue(state: any, kind: string) {
  const now = Date.now();
  const activeIds = new Set(state.decks.filter((d: any) => d.active).map((d: any) => d.id));
  const pool = state.cards.filter((c: any) => activeIds.has(c.deckId));
  return buildQueue(pool, {
    kind,
    deckId: undefined,
    collection: undefined,
    now,
    settings: state.settings.srs,
    done: normalizedDayDone(state.person, now),
    cap: state.settings.sessionLimit,
  } as any);
}

test('v0-v2.0.2.json', async () => {
  jest.useFakeTimers({ now: DAY1 });
  const box = await boot(DataProvider, useData);
  const a = () => box.current.actions;

  // Onboarding: pick German, keep the default goals, "Start learning".
  await pass(20_000);
  await tap(() => {
    a().setGoals(30, 10);
    a().updateSrsSettings({ dailyNewLimit: 10, dailyReviewLimit: Math.max(30, 30) });
    CURATED_LANGUAGES.find((g) => g.deckLang === 'German')!.decks.forEach((d) => a().addCatalogDeck(d.id));
    a().markOnboarded();
  });

  // Day 1 session from onboarding: 3 ratings, then the close button.
  await studySession(box, {
    queue: sessionQueue(box.current.state, 'scheduled'),
    kind: 'scheduled',
    label: 'German decks',
    ratings: [
      { r: 'good', thinkMs: 4_000, answerMs: 2_000 },
      { r: 'again', thinkMs: 6_000, answerMs: 4_000 },
      { r: 'easy', thinkMs: 3_000, answerMs: 1_500 },
    ],
    end: 'exit',
    withStudyDay: false,
    applyRating,
    dayKeyOf,
  });

  // Settings: speak the word on reveal (non-default, to test the mapping).
  await pass(30_000);
  await tap(() => a().updateAppSettings({ autoPlayAudio: true }));

  // Import → From a file → a small CSV (import.tsx finish() + runImport()).
  await pass(60_000);
  const parsed = parseImportCsv(CSV, 'Spanish kitchen.csv');
  const lang = inferLang([parsed.name, ...(parsed.fieldNames ?? [])]);
  const have = new Set(box.current.state.cards.map((x: any) => x.word.toLowerCase()));
  const fresh = parsed.payload.filter((p) => !have.has(p.word.toLowerCase()));
  await tap(() => a().importDeck({ name: parsed.name, flag: LANG_FLAGS[lang] ?? '📄', lang }, fresh));

  // Browse: star two cards (bulk bar), flag one (bulk bar).
  await pass(45_000);
  const cards = box.current.state.cards;
  const kitchen = box.current.state.decks.find((d: any) => d.name === parsed.name);
  const kitchenCards = cards.filter((c: any) => c.deckId === kitchen.id);
  await tap(() => a().setCardProps([cards[5].id, kitchenCards[1].id], { fav: true }));
  await pass(5_000);
  await tap(() => a().setCardProps([cards[12].id], { flagged: true }));

  // Day 2: Study, 3 ratings, then the OS kills the app mid-session.
  await jumpTo(DAY2);
  await studySession(box, {
    queue: sessionQueue(box.current.state, 'scheduled'),
    kind: 'scheduled',
    label: 'All decks',
    ratings: [
      { r: 'good', thinkMs: 5_000, answerMs: 2_500 },
      { r: 'hard', thinkMs: 7_000, answerMs: 3_500 },
      { r: 'good', thinkMs: 4_000, answerMs: 1_000 },
    ],
    end: 'kill',
    withStudyDay: false,
    applyRating,
    dayKeyOf,
  });

  const doc = await writeStored();
  expect(doc.inProgressSession).not.toBeNull();
  expect(doc.inProgressSession.studyDay).toBeUndefined();
  expect(doc.sessions).toHaveLength(1);
  expect(doc.reviewLog).toHaveLength(6);
  expect(doc.cards.length).toBeLessThanOrEqual(80);
  expect(doc.cards.some((c: any) => c.word === 'die Stunde')).toBe(true);
});
TS

  cat >"$dir/src/__fixturegen__/empty.test.ts" <<'TS'
/** TEMPORARY: v2.0.2 user who studied once, then deleted every deck → v0-empty-library.json */
import { CURATED_LANGUAGES } from '../domain/deckCatalog';
import { buildQueue } from '../domain/queue';
import { applyRating } from '../domain/srs';
import { dayKeyOf } from '../domain/types';
import { DataProvider, normalizedDayDone, useData } from '../store/DataContext';
import { boot, pass, studySession, tap, writeStored } from './harness';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const DAY1 = Date.UTC(2026, 6, 8, 18, 45); // Wed 8 Jul 2026, 18:45

test('v0-empty-library.json', async () => {
  jest.useFakeTimers({ now: DAY1 });
  const box = await boot(DataProvider, useData);
  const a = () => box.current.actions;

  // Onboarding: pick French (one small curated deck).
  await pass(15_000);
  await tap(() => {
    a().setGoals(30, 10);
    a().updateSrsSettings({ dailyNewLimit: 10, dailyReviewLimit: 30 });
    CURATED_LANGUAGES.find((g) => g.deckLang === 'French')!.decks.forEach((d) => a().addCatalogDeck(d.id));
    a().markOnboarded();
  });

  const state = box.current.state;
  const now = Date.now();
  await studySession(box, {
    queue: buildQueue(state.cards, {
      kind: 'scheduled',
      deckId: undefined,
      collection: undefined,
      now,
      settings: state.settings.srs,
      done: normalizedDayDone(state.person, now),
      cap: state.settings.sessionLimit,
    } as any),
    kind: 'scheduled',
    label: 'French decks',
    ratings: [
      { r: 'good', thinkMs: 4_000, answerMs: 2_000 },
      { r: 'good', thinkMs: 5_000, answerMs: 2_000 },
    ],
    end: 'exit',
    withStudyDay: false,
    applyRating,
    dayKeyOf,
  });

  // Deck editor → Delete deck → "Delete the deck and its cards".
  await pass(120_000);
  for (const deck of box.current.state.decks) {
    await tap(() => a().deleteDeck(deck.id, { kind: 'delete' }));
  }

  const doc = await writeStored();
  expect(doc.cards).toHaveLength(0);
  expect(doc.decks).toHaveLength(0);
  expect(doc.sessions).toHaveLength(1);
  expect(doc.settings.ttsEnabled).toBe(true);
});
TS

  run_gen "$dir" src/__fixturegen__/library.test.ts "$OUT_DIR/v0-v2.0.2.json"
  run_gen "$dir" src/__fixturegen__/empty.test.ts "$OUT_DIR/v0-empty-library.json"
  remove_worktree "$REPO" "$dir"
}

# ------------------------------------------------------- German fork (v0)

gen_fork() {
  local dir="$SCRATCH/old-fork"
  echo "== German fork ($FORK_REPO @ $FORK_REF)"
  need_anki_fixtures
  add_worktree "$FORK_REPO" "$FORK_REF" "$dir"

  cat >"$dir/src/__fixturegen__/fork.test.ts" <<'TS'
/** TEMPORARY: German fork user (bundled decks + one curated deck) → v0-german-fork.json */
import { ankiDeckName, groupNotesBySection, parseAnkiModels } from '../domain/anki';
import { deckNameFromFile } from '../domain/importFile';
import { buildQueue } from '../domain/queue';
import { applyRating } from '../domain/srs';
import { dayKeyOf } from '../domain/types';
import { DataProvider, normalizedDayDone, useData } from '../store/DataContext';
import {
  boot,
  jumpTo,
  parseFixtureApkg,
  pass,
  readAnkiFixture,
  studySession,
  tap,
  writeStored,
} from './harness';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const DAY1 = Date.UTC(2026, 6, 14, 6, 50); // Tue 14 Jul 2026, 06:50
const DAY2 = Date.UTC(2026, 6, 15, 21, 15); // Wed 15 Jul 2026, 21:15

function sessionQueue(state: any) {
  const now = Date.now();
  const activeIds = new Set(state.decks.filter((d: any) => d.active).map((d: any) => d.id));
  const pool = state.cards.filter((c: any) => activeIds.has(c.deckId));
  return buildQueue(pool, {
    kind: 'scheduled',
    deckId: undefined,
    collection: undefined,
    now,
    settings: state.settings.srs,
    done: normalizedDayDone(state.person, now),
    cap: state.settings.sessionLimit,
  } as any);
}

test('v0-german-fork.json', async () => {
  jest.useFakeTimers({ now: DAY1 });
  const box = await boot(DataProvider, useData);
  const a = () => box.current.actions;

  // Onboarding → "Add your German decks": Verbs, then Grammar. This is
  // importBundledDeck() without the asset I/O: parse → stamp 🇩🇪 / German →
  // importDeck. The decks are the 20-note Anki fixtures.
  await pass(25_000);
  for (const name of ['german_verbs', 'german_grammar']) {
    const parsed = parseFixtureApkg(
      readAnkiFixture(name),
      { parseAnkiModels, groupNotesBySection, ankiDeckName },
      deckNameFromFile,
    );
    await tap(() => a().importDeck({ name: parsed.name, flag: '🇩🇪', lang: 'German' }, parsed.payload));
    await pass(3_000);
  }
  await tap(() => {
    a().setGoals(20, 8);
    a().updateSrsSettings({ dailyNewLimit: 8, dailyReviewLimit: Math.max(20, 30) });
    a().markOnboarded();
  });

  // Day 1 session ("Start learning"): 3 ratings, then the close button.
  await studySession(box, {
    queue: sessionQueue(box.current.state),
    kind: 'scheduled',
    label: 'German decks',
    ratings: [
      { r: 'good', thinkMs: 5_000, answerMs: 2_000 },
      { r: 'good', thinkMs: 4_000, answerMs: 3_500 },
      { r: 'again', thinkMs: 9_000, answerMs: 2_000 },
    ],
    end: 'exit',
    withStudyDay: true,
    applyRating,
    dayKeyOf,
  });

  // Study tab "+" → curated catalog → German — Conversation (level/type/lang).
  await pass(90_000);
  await tap(() => a().addCatalogDeck('de-conversation'));

  // Browse: star two cards, flag one.
  await pass(40_000);
  const cards = box.current.state.cards;
  await tap(() => a().setCardProps([cards[3].id, cards[cards.length - 2].id], { fav: true }));
  await pass(6_000);
  await tap(() => a().setCardProps([cards[25].id], { flagged: true }));

  // Day 2, late evening: Study, 3 ratings, then the OS kills the app.
  await jumpTo(DAY2);
  await studySession(box, {
    queue: sessionQueue(box.current.state),
    kind: 'scheduled',
    label: 'All decks',
    ratings: [
      { r: 'good', thinkMs: 6_000, answerMs: 2_500 },
      { r: 'easy', thinkMs: 3_000, answerMs: 1_200 },
      { r: 'hard', thinkMs: 8_000, answerMs: 4_000 },
    ],
    end: 'kill',
    withStudyDay: true,
    applyRating,
    dayKeyOf,
  });

  const doc = await writeStored();
  expect(doc.inProgressSession.studyDay).toBe('2026-07-15');
  expect(doc.sessions).toHaveLength(1);
  expect(doc.reviewLog).toHaveLength(6);
  expect(doc.cards.length).toBeLessThanOrEqual(80);
  expect(doc.cards.some((c: any) => typeof c.word === 'string' && c.level != null)).toBe(true);
});
TS

  run_gen "$dir" src/__fixturegen__/fork.test.ts "$OUT_DIR/v0-german-fork.json"
  remove_worktree "$FORK_REPO" "$dir"
}

# --------------------------------------------------------- main@1333d48 (v1)

gen_main() {
  local dir="$SCRATCH/old-main"
  echo "== main ($MAIN_REF)"
  need_anki_fixtures
  add_worktree "$REPO" "$MAIN_REF" "$dir"

  cat >"$dir/src/__fixturegen__/main.test.ts" <<'TS'
/** TEMPORARY: generic-app user (own deck, CSV, .apkg subdecks) → v1-main-1333d48.json */
import { ankiDeckName, groupNotesBySection, parseAnkiModels } from '../domain/anki';
import { deckNameFromFile, parseImportCsv } from '../domain/importFile';
import { buildQueue } from '../domain/queue';
import { applyRating } from '../domain/srs';
import { dayKeyOf } from '../domain/types';
import { DataProvider, normalizedDayDone, useData } from '../store/DataContext';
import {
  boot,
  jumpTo,
  parseFixtureApkg,
  pass,
  readAnkiFixture,
  studySession,
  tap,
  writeStored,
} from './harness';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const DAY1 = Date.UTC(2026, 6, 20, 12, 5); // Mon 20 Jul 2026, 12:05
const DAY2 = Date.UTC(2026, 6, 21, 7, 40); // Tue 21 Jul 2026, 07:40

// Positional v1 columns: front, back, example, notes, tags…
const CSV = [
  'Front,Back,Example,Notes,Tags',
  'H2O,water,H2O boils at 100 °C at sea level.,,chemistry',
  'NaCl,sodium chloride (table salt),,ionic compound,chemistry',
  'CO2,carbon dioxide,Plants take in CO2.,,chemistry|gas',
  'O3,ozone,,"three oxygen atoms, pale blue gas",chemistry|gas',
  'CH4,methane,Methane is the main part of natural gas.,,chemistry|gas',
  'Fe,iron,,element 26,chemistry',
].join('\n');

const CAPITALS: { front: string; back: string; example?: string; notes?: string; tags?: string[] }[] = [
  { front: 'France', back: 'Paris', tags: ['europe'] },
  { front: 'Japan', back: 'Tokyo', example: 'Tokyo is the largest city in Japan.', tags: ['asia'] },
  { front: 'Canada', back: 'Ottawa', notes: 'Not Toronto!', tags: ['americas'] },
  { front: 'Kenya', back: 'Nairobi', tags: ['africa'] },
  { front: 'Australia', back: 'Canberra', notes: 'Not Sydney.' },
];

function sessionQueue(state: any) {
  const now = Date.now();
  const activeIds = new Set(state.decks.filter((d: any) => d.active).map((d: any) => d.id));
  const pool = state.cards.filter((c: any) => activeIds.has(c.deckId));
  return buildQueue(pool, {
    kind: 'scheduled',
    deckId: undefined,
    collection: undefined,
    now,
    settings: state.settings.srs,
    done: normalizedDayDone(state.person, now),
    cap: state.settings.sessionLimit,
  } as any);
}

test('v1-main-1333d48.json', async () => {
  jest.useFakeTimers({ now: DAY1 });
  const box = await boot(DataProvider, useData);
  const a = () => box.current.actions;

  // Onboarding: goals 30 reviews / 10 new → Finish.
  await pass(18_000);
  await tap(() => {
    a().setGoals(30, 10);
    a().updateSrsSettings({ dailyNewLimit: 10, dailyReviewLimit: Math.max(30, 30) });
    a().markOnboarded();
  });

  // Deck editor → new deck; card editor → 5 cards.
  await pass(30_000);
  const capitals = await tap(() => a().addDeck({ name: 'World capitals', icon: '🌍', desc: 'Countries → capitals' }));
  for (const card of CAPITALS) {
    await pass(12_000);
    await tap(() => a().addCard(capitals.id, { ...card, deckId: capitals.id }));
  }

  // Import → From a file → CSV (import.tsx finish() + runImport()).
  await pass(50_000);
  const csv = parseImportCsv(CSV, 'Chemistry basics.csv');
  {
    const have = new Set(box.current.state.cards.map((x: any) => x.front.toLowerCase()));
    const fresh = csv.payload.filter((p) => !have.has(p.front.toLowerCase()));
    await tap(() => a().importDeck({ name: csv.name }, fresh));
  }

  // Import → From a file → Algo_Patterns.apkg → "Choose subdecks": keep two
  // of the three (import.tsx continueSections() + runImport()).
  await pass(40_000);
  const apkg = parseFixtureApkg(
    readAnkiFixture('algo_patterns'),
    { parseAnkiModels, groupNotesBySection, ankiDeckName },
    deckNameFromFile,
  );
  const chosen = apkg.sections.filter((s: any) => !/Advanced/.test(s.name));
  const payload = chosen.flatMap((s: any) => s.payload);
  const apkgName = ankiDeckName(
    chosen.map((s: any) => s.name),
    apkg.name,
  );
  {
    const have = new Set(box.current.state.cards.map((x: any) => x.front.toLowerCase()));
    const fresh = payload.filter((p: any) => !have.has(p.front.toLowerCase()));
    await tap(() => a().importDeck({ name: apkgName }, fresh));
  }

  // Settings: a smaller session size (non-default, must survive migration).
  await pass(20_000);
  await tap(() => a().updateAppSettings({ sessionLimit: 30 }));

  // Browse: star two cards, flag one.
  await pass(35_000);
  const cards = box.current.state.cards;
  await tap(() => a().setCardProps([cards[1].id, cards[8].id], { fav: true }));
  await pass(4_000);
  await tap(() => a().setCardProps([cards[14].id], { flagged: true }));

  // Day 1 session: 3 ratings, then the close button.
  await pass(60_000);
  await studySession(box, {
    queue: sessionQueue(box.current.state),
    kind: 'scheduled',
    label: 'All decks',
    ratings: [
      { r: 'easy', thinkMs: 3_000, answerMs: 1_000 },
      { r: 'good', thinkMs: 5_000, answerMs: 2_500 },
      { r: 'again', thinkMs: 8_000, answerMs: 3_000 },
    ],
    end: 'exit',
    withStudyDay: true,
    applyRating,
    dayKeyOf,
  });

  // Day 2: Study, 3 ratings, then the OS kills the app mid-session.
  await jumpTo(DAY2);
  await studySession(box, {
    queue: sessionQueue(box.current.state),
    kind: 'scheduled',
    label: 'All decks',
    ratings: [
      { r: 'good', thinkMs: 4_000, answerMs: 2_000 },
      { r: 'hard', thinkMs: 6_000, answerMs: 3_000 },
      { r: 'good', thinkMs: 4_500, answerMs: 2_200 },
    ],
    end: 'kill',
    withStudyDay: true,
    applyRating,
    dayKeyOf,
  });

  const doc = await writeStored();
  expect(doc.inProgressSession.studyDay).toBe('2026-07-21');
  expect(doc.sessions).toHaveLength(1);
  expect(doc.reviewLog).toHaveLength(6);
  expect(doc.cards.every((c: any) => typeof c.front === 'string' && c.word === undefined)).toBe(true);
});
TS

  run_gen "$dir" src/__fixturegen__/main.test.ts "$OUT_DIR/v1-main-1333d48.json"
  remove_worktree "$REPO" "$dir"
}

# ------------------------------------------- edge cases derived from v1-main

gen_derived() {
  echo "== derived edge cases (from v1-main-1333d48.json)"
  if [ ! -f "$OUT_DIR/v1-main-1333d48.json" ]; then
    echo "missing v1-main-1333d48.json — run the 'main' step first" >&2
    exit 1
  fi
  OUT_DIR="$OUT_DIR" node <<'JS'
// Each derived file = the v1 document with ONE kind of damage, saved compact
// like serialize() (JSON.stringify). JSON cannot hold NaN or Infinity:
// JSON.stringify writes them as null — so "NaN on disk" IS null.
const fs = require('fs');
const path = require('path');
const dir = process.env.OUT_DIR;
const read = () => JSON.parse(fs.readFileSync(path.join(dir, 'v1-main-1333d48.json'), 'utf8'));
const write = (name, doc) => {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(doc), 'utf8');
  console.log('  wrote ' + name);
};

// 1. The in-flight marker without `studyDay` (as written before 899a1d6).
{
  const doc = read();
  if (!doc.inProgressSession || !doc.inProgressSession.studyDay) throw new Error('v1 marker lost');
  delete doc.inProgressSession.studyDay;
  write('v1-marker-no-studyDay.json', doc);
}

// 2. One card whose deck no longer exists (the old "move to a deleted deck" bug, H2).
{
  const doc = read();
  const card = doc.cards.find((c) => c.front === 'NaCl');
  if (!card) throw new Error('NaCl card missing');
  card.deckId = 'd-deleted-deck';
  write('v1-orphan-card.json', doc);
}

// 3. Broken numbers and texts, one repair case per card (spec §3.3 sanitize).
{
  const doc = read();
  const byFront = (front) => {
    const card = doc.cards.find((c) => c.front === front);
    if (!card) throw new Error(front + ' card missing');
    return card;
  };
  Object.assign(byFront('France'), { ease: NaN, due: NaN }); //        non-finite ease, due
  Object.assign(byFront('Japan'), { ease: 1.1 }); //                     ease below the 1.3 floor
  Object.assign(byFront('Canada'), { intervalDays: Infinity, reps: NaN, lapses: NaN }); // non-finite counters
  Object.assign(byFront('Kenya'), { reps: -2, lapses: -1 }); //          negative counters
  Object.assign(byFront('Australia'), { reps: 3, stepIndex: 1.5 }); //   bad stepIndex, reps > 0
  Object.assign(byFront('H2O'), { reps: 0, stepIndex: -1 }); //          bad stepIndex, reps = 0
  Object.assign(byFront('CO2'), { front: 42, back: null }); //           non-string texts
  Object.assign(byFront('CH4'), { due: '2026-07-22' }); //               a string where a number belongs
  delete byFront('Fe').back; //                                          missing text
  write('v1-nan-fields.json', doc);
}
JS
}

# ------------------------------------------------------------------- main

case "$STEP" in
  all) gen_v202; gen_fork; gen_main; gen_derived ;;
  v202) gen_v202 ;;
  fork) gen_fork ;;
  main) gen_main ;;
  derived) gen_derived ;;
esac
rmdir "$SCRATCH" 2>/dev/null || true # Only an empty folder goes; --keep keeps it.
echo "done. Fixtures are in $OUT_DIR"
