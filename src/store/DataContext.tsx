/**
 * The data store — implements WIRING.md §2's callback contract for real:
 * SM-2 grade writes with review-log-backed undo (A1), session recording with
 * full tallies (fixes OPP-DATA-1), streak/freeze roll-over, XP + achievement
 * payout, bulk card actions, deck CRUD with safe delete, and import.
 *
 * Persistence: one JSON document in AsyncStorage, debounce-saved. Seeded
 * from src/domain/seed.ts on first boot.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  AchievementDef,
  achievementStatuses,
  levelInfo,
  LevelInfo,
  MAX_FREEZES,
  newlyUnlocked,
  sessionXpItems,
  sessionXpTotal,
  XpItem,
} from '@/domain/gamification';
import { applyRating } from '@/domain/srs';
import {
  AppSettings,
  Card,
  DataState,
  dayKeyOf,
  DayDone,
  Deck,
  InProgressSession,
  MASTERED_INTERVAL_DAYS,
  Person,
  Rating,
  ReviewLogEntry,
  SessionKind,
  SessionRecord,
  SrsSettings,
} from '@/domain/types';
import { buildSeedState } from '@/domain/seed';
import { DeleteStrategy, resolveDeckDeletion } from './deckOps';
import { BACKUP_KEY, classifyStored, serialize, STORAGE_KEY } from './persistence';
import { attributionDay, rollStreak, tallyReview, untallyReview } from './tally';

const SAVE_DEBOUNCE_MS = 400;
const REVIEW_LOG_CAP = 400;

let idCounter = 0;
function uid(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
}

/** Roll dayDone forward if the calendar day changed since last write. */
export function normalizedDayDone(person: Person, now: number): DayDone {
  const today = dayKeyOf(now);
  return person.dayDone.dayKey === today
    ? person.dayDone
    : { dayKey: today, reviews: 0, neww: 0 };
}

export interface CompletionPayout {
  kind: SessionKind;
  label: string;
  counts: Record<Rating, number>;
  total: number;
  bestRun: number;
  accuracy: number;
  durationSec: number;
  xpItems: XpItem[];
  xpTotal: number;
  levelBefore: LevelInfo;
  levelAfter: LevelInfo;
  streakDays: number;
  newAchievements: AchievementDef[];
  freezeEarned: boolean;
}

export interface CompleteSessionArgs {
  kind: SessionKind;
  label: string;
  counts: Record<Rating, number>;
  total: number;
  bestRun: number;
  durationSec: number;
  fastAnswers: number;
  /**
   * The calendar day the session's reviews belong to (its start day). Threaded
   * from the session screen so the streak roll, SessionRecord and lastStudyDay
   * are attributed to the day the user studied — not completeSession's own
   * clock, which is a different day for a session finishing after local midnight
   * or one banked by the boot reconciler on a later day. Optional at runtime
   * (a legacy in-flight marker omits it → falls back to the completion instant).
   */
  studyDay?: string;
  /**
   * The session's final rated card (post-rating). The final rateCard commits in
   * the same tick as completeSession, so the committed-state mirror is stale by
   * one rating; passing the fresh card lets mastery achievements be
   * scored against the true end-of-session state.
   */
  finalCard?: Card;
}

interface DataActions {
  rateCard: (cardId: string, rating: Rating, opts?: { writeSchedule?: boolean }) => void;
  undoLastReview: () => boolean;
  completeSession: (args: CompleteSessionArgs) => CompletionPayout;
  clearLastCompletion: () => void;
  /** Persist a snapshot of the in-flight session so an app-kill mid-session can
   *  be reconciled on next boot (M5). Cleared by completeSession on clean exit,
   *  or with `null` when an undo rolls the session back to zero reviews. */
  trackSession: (snapshot: InProgressSession | null) => void;

  setCardProps: (cardIds: string[], patch: Partial<Card>) => void;
  buryCard: (cardId: string) => void;
  addCard: (
    deckId: string,
    fields: Pick<Card, 'front' | 'back'> & Partial<Card>,
  ) => Card;
  updateCard: (cardId: string, patch: Partial<Card>) => void;
  deleteCard: (cardId: string) => void;

  addDeck: (fields: Pick<Deck, 'name'> & Partial<Deck>) => Deck;
  updateDeck: (deckId: string, patch: Partial<Deck>) => void;
  deleteDeck: (deckId: string, strategy: DeleteStrategy) => void;
  importDeck: (
    deck: Pick<Deck, 'name'> & Partial<Deck>,
    cards: (Pick<Card, 'front' | 'back'> & Partial<Card>)[],
  ) => Deck;

  setGoals: (goalReviews: number, goalNew: number) => void;
  updateSrsSettings: (patch: Partial<SrsSettings>) => void;
  updateAppSettings: (patch: Partial<AppSettings>) => void;
  markOnboarded: () => void;
  replayOnboarding: () => void;
  factoryReset: () => void;
}

/** Persistence health: 'read' blocks writes (load failed); 'write' = a save failed. */
export type PersistError = 'read' | 'write' | null;

interface DataValue {
  ready: boolean;
  state: DataState;
  lastCompletion: CompletionPayout | null;
  persistError: PersistError;
  actions: DataActions;
}

const DataContext = createContext<DataValue | null>(null);

export function DataProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<DataState>(() => buildSeedState(Date.now()));
  const [ready, setReady] = useState(false);
  const [lastCompletion, setLastCompletion] = useState<CompletionPayout | null>(null);
  const [persistError, setPersistError] = useState<PersistError>(null);
  // While false, the debounced save is suppressed — set when the initial read
  // FAILS, so a transient error can't overwrite intact stored data (C1).
  const canSaveRef = useRef(true);

  // Mirror for actions that need the latest committed state synchronously.
  // Updated in an effect (post-commit) — actions only fire from event
  // handlers, which always run after commit, so the mirror is never stale
  // when read.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Mirror `ready` for the flush callback, whose empty dep array can't observe
  // `ready` directly — it must honour the same write-gate as the debounced save.
  const readyRef = useRef(ready);
  useEffect(() => {
    readyRef.current = ready;
  }, [ready]);

  /* ------------------------------------------------------ load & save */

  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        if (cancelled) return;
        const outcome = classifyStored(raw);
        if (outcome.kind === 'loaded') {
          setState(outcome.state);
        } else if (outcome.kind === 'corrupt') {
          // Preserve the unreadable blob before the seed overwrites the live
          // key, so a partial/garbled write is recoverable rather than lost.
          AsyncStorage.setItem(BACKUP_KEY, outcome.raw).catch(() => {});
        }
        // 'first-boot': keep the blank seed already in `state`.
      })
      .catch(() => {
        // The READ FAILED (transient native error) — distinct from "no data".
        // Block saves: entering writable mode here would let the debounced save
        // clobber the user's still-intact stored document with the seed (C1).
        if (!cancelled) {
          canSaveRef.current = false;
          setPersistError('read');
        }
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Write the latest committed state now, cancelling any pending debounce.
  // Used by the background/unmount flush so the last <=400ms of changes (e.g.
  // a just-finished session) are not dropped on an OS suspend/kill (M16).
  const flushSave = useCallback(() => {
    // Gate on `ready` too, not just canSaveRef: during the initial load window
    // `state`/`stateRef.current` are still the blank seed and `ready` is false,
    // so a background/unmount flush here would overwrite intact stored data with
    // the seed before the read that would have loaded it (a regression the M16
    // flush introduced past C1's gate).
    if (!readyRef.current || !canSaveRef.current) return;
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    AsyncStorage.setItem(STORAGE_KEY, serialize(stateRef.current)).catch(() => {
      setPersistError('write');
    });
  }, []);

  useEffect(() => {
    if (!ready || !canSaveRef.current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      AsyncStorage.setItem(STORAGE_KEY, serialize(state)).catch(() => {
        // Surface instead of swallowing: a failed write (e.g. quota on a large
        // import) means data is not persisting (M15).
        setPersistError('write');
      });
    }, SAVE_DEBOUNCE_MS);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [state, ready]);

  // Flush a pending write when the app backgrounds or the provider unmounts.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'background' || next === 'inactive') flushSave();
    });
    return () => {
      sub.remove();
      flushSave();
    };
  }, [flushSave]);

  /* ------------------------------------------------------------ rating */

  const rateCard = useCallback<DataActions['rateCard']>((cardId, rating, opts) => {
    const writeSchedule = opts?.writeSchedule ?? true;
    const now = Date.now();
    setState((prev) => {
      const card = prev.cards.find((c) => c.id === cardId);
      if (!card) return prev;
      const wasNew = card.reps === 0;
      const dayDone = normalizedDayDone(prev.person, now);
      const nextDayDone = tallyReview(dayDone, { wasNew, writeSchedule });

      if (!writeSchedule) {
        // Cram is free practice: it touches neither the schedule nor the day's
        // review/new budgets. tallyReview returned dayDone unchanged, so commit
        // only a genuine calendar rollover (else no-op).
        return prev.person.dayDone === nextDayDone
          ? prev
          : { ...prev, person: { ...prev.person, dayDone: nextDayDone } };
      }

      const entry: ReviewLogEntry = {
        id: uid('rl'),
        cardId,
        rating,
        atMs: now,
        prev: {
          ease: card.ease,
          intervalDays: card.intervalDays,
          stepIndex: card.stepIndex,
          reps: card.reps,
          lapses: card.lapses,
          due: card.due,
          lastReviewedAt: card.lastReviewedAt,
        },
        wasNew,
      };
      const rated = applyRating(card, rating, prev.settings.srs, now);
      return {
        ...prev,
        cards: prev.cards.map((c) => (c.id === cardId ? rated : c)),
        reviewLog: [...prev.reviewLog.slice(-REVIEW_LOG_CAP + 1), entry],
        person: { ...prev.person, dayDone: nextDayDone },
      };
    });
  }, []);

  const undoLastReview = useCallback<DataActions['undoLastReview']>(() => {
    const prev = stateRef.current;
    const entry = prev.reviewLog[prev.reviewLog.length - 1];
    if (!entry) return false;
    setState((s) => {
      const e = s.reviewLog[s.reviewLog.length - 1];
      if (!e) return s;
      const dayDone = normalizedDayDone(s.person, Date.now());
      return {
        ...s,
        cards: s.cards.map((c) => (c.id === e.cardId ? { ...c, ...e.prev } : c)),
        reviewLog: s.reviewLog.slice(0, -1),
        person: {
          ...s.person,
          dayDone: untallyReview(dayDone, { wasNew: e.wasNew }),
        },
      };
    });
    return true;
  }, []);

  /* ------------------------------------------------- session completion */

  const completeSession = useCallback<DataActions['completeSession']>((args) => {
    const now = Date.now();
    // Attribute the payout to the day the user actually studied (the session's
    // start day), not completeSession's own clock — which differs for a session
    // finishing after local midnight or one banked by the boot reconciler on a
    // later day. Falls back to `now` for a legacy marker that carries no day.
    const studyDay = attributionDay(args.studyDay, now);
    const prev = stateRef.current;
    const person = prev.person;

    // Streak roll. Depends only on `person` (streak/lastStudyDay/freezes), which
    // the session's final rateCard never touches — so this snapshot is accurate.
    const roll = rollStreak(person, studyDay);
    const streak = roll.streak;
    const freezes = roll.freezes;
    const freezeUsedDays = roll.freezeUsedDays;
    let freezeEarned = false;

    // L10: the +10 daily-streak bonus is paid once per day — only on the session
    // that actually advanced the streak.
    const xpItems = sessionXpItems(
      args.counts,
      args.total,
      args.bestRun,
      roll.advanced ? streak : 0,
    );
    const xpTotal = sessionXpTotal(xpItems);
    const levelBefore = levelInfo(person.xp);
    const levelAfter = levelInfo(person.xp + xpTotal);

    const session: SessionRecord = {
      id: uid('s'),
      dayKey: studyDay,
      atMs: now,
      kind: args.kind,
      counts: args.counts,
      total: args.total,
      bestRun: args.bestRun,
      xp: xpTotal,
    };

    // M6: the final rateCard committed in this same tick, so stateRef's cards are
    // stale by one rating. Substitute the freshly-rated final card before scoring
    // card-derived achievements, so a card that just graduated to mastered is
    // counted this session, not next.
    const finalCard = args.finalCard;
    const cards = finalCard
      ? prev.cards.map((c) => (c.id === finalCard.id ? finalCard : c))
      : prev.cards;
    const masteredCount = cards.filter(
      (c) => c.reps > 0 && c.stepIndex === null && c.intervalDays >= MASTERED_INTERVAL_DAYS,
    ).length;
    const projectedPerson: Person = {
      ...person,
      xp: person.xp + xpTotal,
      streak,
      bestStreak: Math.max(person.bestStreak, streak),
      fastAnswers: person.fastAnswers + args.fastAnswers,
    };
    const unlocked = newlyUnlocked({
      person: projectedPerson,
      cards,
      sessions: [...prev.sessions, session],
      masteredCount,
      fastAnswers: projectedPerson.fastAnswers,
    });
    let freezesAfter = freezes;
    const newAchievements: Record<string, number> = {};
    for (const def of unlocked) {
      newAchievements[def.id] = now;
      if (def.grantsFreeze && freezesAfter < MAX_FREEZES) {
        freezesAfter += 1;
        freezeEarned = true;
      }
    }

    const accuracy =
      args.total === 0 ? 0 : Math.round(((args.total - args.counts.again) / args.total) * 100);

    const payout: CompletionPayout = {
      kind: args.kind,
      label: args.label,
      counts: args.counts,
      total: args.total,
      bestRun: args.bestRun,
      accuracy,
      durationSec: args.durationSec,
      xpItems,
      xpTotal,
      levelBefore,
      levelAfter,
      streakDays: streak,
      newAchievements: unlocked,
      freezeEarned,
    };

    // Derive the person from the LATEST state inside the updater: the final
    // rateCard of the session commits in the same event tick, and its
    // dayDone increments must not be clobbered by a stale snapshot. The
    // streak/xp/freeze fields are safe to precompute — rateCard never
    // touches them.
    setState((s) => ({
      ...s,
      person: {
        ...s.person,
        xp: s.person.xp + xpTotal,
        streak,
        bestStreak: Math.max(s.person.bestStreak, streak),
        freezes: freezesAfter,
        freezeUsedDays,
        lastStudyDay: studyDay,
        dayDone: normalizedDayDone(s.person, now),
        fastAnswers: s.person.fastAnswers + args.fastAnswers,
        achievements: { ...s.person.achievements, ...newAchievements },
      },
      sessions: [...s.sessions, session],
      // Clear the in-flight marker in the SAME commit that banks the payout, so
      // persistence is atomic: the boot reconciler can never double-count (M5).
      inProgressSession: null,
    }));
    setLastCompletion(payout);
    return payout;
  }, []);

  const clearLastCompletion = useCallback(() => setLastCompletion(null), []);

  // Snapshot the in-flight session (updated per rating) so a process-kill that
  // skips completeSession doesn't lose its payout — reconciled on next boot (M5).
  const trackSession = useCallback<DataActions['trackSession']>((snapshot) => {
    setState((s) => ({ ...s, inProgressSession: snapshot }));
  }, []);

  // One-shot on first ready: bank a session that was in flight when the app was
  // last killed. completeSession reads the now-loaded state, banks the XP/streak/
  // record those per-rating schedule writes never got, and clears the marker in
  // the same commit (atomic — no double-count). clearLastCompletion keeps it
  // silent: no payout screen for a session the user didn't just finish (M5).
  const reconciledRef = useRef(false);
  useEffect(() => {
    if (!ready || reconciledRef.current) return;
    reconciledRef.current = true;
    const marker = stateRef.current.inProgressSession;
    if (marker) {
      completeSession(marker);
      clearLastCompletion();
    }
  }, [ready, completeSession, clearLastCompletion]);

  /* ------------------------------------------------------- card actions */

  const setCardProps = useCallback<DataActions['setCardProps']>((cardIds, patch) => {
    const ids = new Set(cardIds);
    setState((s) => ({
      ...s,
      cards: s.cards.map((c) => (ids.has(c.id) ? { ...c, ...patch } : c)),
    }));
  }, []);

  const buryCard = useCallback<DataActions['buryCard']>((cardId) => {
    const tomorrow = new Date();
    tomorrow.setHours(24, 0, 0, 0);
    setState((s) => ({
      ...s,
      cards: s.cards.map((c) =>
        c.id === cardId ? { ...c, buriedUntil: tomorrow.getTime() } : c,
      ),
    }));
  }, []);

  const addCard = useCallback<DataActions['addCard']>((deckId, fields) => {
    const now = Date.now();
    const ease = stateRef.current.settings.srs.startingEase;
    const card: Card = {
      id: uid('c'),
      deckId,
      front: fields.front,
      back: fields.back,
      example: fields.example,
      notes: fields.notes,
      tags: fields.tags,
      fav: fields.fav ?? false,
      flagged: false,
      suspended: false,
      buriedUntil: null,
      ease,
      intervalDays: 0,
      stepIndex: null,
      reps: 0,
      lapses: 0,
      due: now,
      createdAt: now,
      lastReviewedAt: null,
    };
    setState((s) => ({ ...s, cards: [...s.cards, card] }));
    return card;
  }, []);

  const updateCard = useCallback<DataActions['updateCard']>((cardId, patch) => {
    setState((s) => ({
      ...s,
      cards: s.cards.map((c) => (c.id === cardId ? { ...c, ...patch } : c)),
    }));
  }, []);

  const deleteCard = useCallback<DataActions['deleteCard']>((cardId) => {
    setState((s) => ({ ...s, cards: s.cards.filter((c) => c.id !== cardId) }));
  }, []);

  /* ------------------------------------------------------- deck actions */

  const addDeck = useCallback<DataActions['addDeck']>((fields) => {
    const deck: Deck = {
      id: uid('d'),
      name: fields.name,
      icon: fields.icon ?? '🗂️',
      builtin: false,
      active: fields.active ?? true,
      createdAt: Date.now(),
    };
    setState((s) => ({ ...s, decks: [...s.decks, deck] }));
    return deck;
  }, []);

  const updateDeck = useCallback<DataActions['updateDeck']>((deckId, patch) => {
    setState((s) => ({
      ...s,
      decks: s.decks.map((d) => (d.id === deckId ? { ...d, ...patch } : d)),
    }));
  }, []);

  const deleteDeck = useCallback<DataActions['deleteDeck']>((deckId, strategy) => {
    // The no-orphan invariant lives in resolveDeckDeletion (an invalid move
    // target degrades to keep), so the reducer is just: resolve, then commit.
    setState((s) => ({ ...s, ...resolveDeckDeletion(s, deckId, strategy, Date.now()) }));
  }, []);

  const importDeck = useCallback<DataActions['importDeck']>((deckFields, cardFields) => {
    const now = Date.now();
    const deck: Deck = {
      id: uid('d'),
      name: deckFields.name,
      icon: deckFields.icon ?? '🗂️',
      builtin: false,
      active: true,
      createdAt: now,
    };
    const srs = stateRef.current.settings.srs;
    const cards: Card[] = cardFields.map((f, i) => ({
      id: uid('c'),
      deckId: deck.id,
      front: f.front,
      back: f.back,
      example: f.example,
      notes: f.notes,
      tags: f.tags,
      fav: false,
      flagged: false,
      suspended: f.suspended ?? false,
      buriedUntil: null,
      // preserve imported SRS scheduling when provided (Anki fidelity)
      ease: f.ease ?? srs.startingEase,
      intervalDays: f.intervalDays ?? 0,
      stepIndex: f.stepIndex ?? null,
      reps: f.reps ?? 0,
      lapses: f.lapses ?? 0,
      due: f.due ?? now,
      createdAt: now + i,
      lastReviewedAt: f.lastReviewedAt ?? null,
    }));
    setState((s) => ({ ...s, decks: [...s.decks, deck], cards: [...s.cards, ...cards] }));
    return deck;
  }, []);

  /* ---------------------------------------------------------- settings */

  const setGoals = useCallback<DataActions['setGoals']>((goalReviews, goalNew) => {
    setState((s) => ({ ...s, person: { ...s.person, goalReviews, goalNew } }));
  }, []);

  const updateSrsSettings = useCallback<DataActions['updateSrsSettings']>((patch) => {
    setState((s) => ({
      ...s,
      settings: { ...s.settings, srs: { ...s.settings.srs, ...patch } },
    }));
  }, []);

  const updateAppSettings = useCallback<DataActions['updateAppSettings']>((patch) => {
    setState((s) => ({ ...s, settings: { ...s.settings, ...patch } }));
  }, []);

  const markOnboarded = useCallback(() => {
    setState((s) => ({ ...s, onboarded: true }));
  }, []);

  const replayOnboarding = useCallback(() => {
    setState((s) => ({ ...s, onboarded: false }));
  }, []);

  const factoryReset = useCallback(() => {
    setLastCompletion(null);
    setState(buildSeedState(Date.now()));
    // Recover from a prior read failure: a deliberate reset re-enables saving.
    canSaveRef.current = true;
    setPersistError(null);
    AsyncStorage.removeItem(STORAGE_KEY).catch(() => {});
  }, []);

  const actions = useMemo<DataActions>(
    () => ({
      rateCard,
      undoLastReview,
      completeSession,
      clearLastCompletion,
      trackSession,
      setCardProps,
      buryCard,
      addCard,
      updateCard,
      deleteCard,
      addDeck,
      updateDeck,
      deleteDeck,
      importDeck,
      setGoals,
      updateSrsSettings,
      updateAppSettings,
      markOnboarded,
      replayOnboarding,
      factoryReset,
    }),
    [
      rateCard,
      undoLastReview,
      completeSession,
      clearLastCompletion,
      trackSession,
      setCardProps,
      buryCard,
      addCard,
      updateCard,
      deleteCard,
      addDeck,
      updateDeck,
      deleteDeck,
      importDeck,
      setGoals,
      updateSrsSettings,
      updateAppSettings,
      markOnboarded,
      replayOnboarding,
      factoryReset,
    ],
  );

  const value = useMemo<DataValue>(
    () => ({ ready, state, lastCompletion, persistError, actions }),
    [ready, state, lastCompletion, persistError, actions],
  );

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useData(): DataValue {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error('useData must be used inside DataProvider');
  return ctx;
}

/** Convenience: achievement statuses for the current state. */
export function useAchievements() {
  const { state } = useData();
  return useMemo(() => {
    const masteredCount = state.cards.filter(
      (c) => c.reps > 0 && c.stepIndex === null && c.intervalDays >= 21,
    ).length;
    return achievementStatuses({
      person: state.person,
      cards: state.cards,
      sessions: state.sessions,
      masteredCount,
      fastAnswers: state.person.fastAnswers,
    });
  }, [state]);
}
