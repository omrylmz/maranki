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
  addDays,
  AppSettings,
  Card,
  DataState,
  dayKeyOf,
  DayDone,
  Deck,
  Person,
  Rating,
  ReviewLogEntry,
  SessionKind,
  SessionRecord,
  SrsSettings,
} from '@/domain/types';
import { buildSeedState } from '@/domain/seed';

const STORAGE_KEY = 'maranki.state.v1';
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
}

interface DataActions {
  rateCard: (cardId: string, rating: Rating, opts?: { writeSchedule?: boolean }) => void;
  undoLastReview: () => boolean;
  completeSession: (args: CompleteSessionArgs) => CompletionPayout;
  clearLastCompletion: () => void;

  setCardProps: (cardIds: string[], patch: Partial<Card>) => void;
  buryCard: (cardId: string) => void;
  addCard: (
    deckId: string,
    fields: Pick<Card, 'word' | 'tr'> & Partial<Card>,
  ) => Card;
  updateCard: (cardId: string, patch: Partial<Card>) => void;
  deleteCard: (cardId: string) => void;

  addDeck: (fields: Pick<Deck, 'name'> & Partial<Deck>) => Deck;
  updateDeck: (deckId: string, patch: Partial<Deck>) => void;
  deleteDeck: (
    deckId: string,
    strategy: { kind: 'delete' } | { kind: 'move'; targetDeckId: string } | { kind: 'keep' },
  ) => void;
  importDeck: (
    deck: Pick<Deck, 'name' | 'flag' | 'lang'> & Partial<Deck>,
    cards: (Pick<Card, 'word' | 'tr'> & Partial<Card>)[],
  ) => Deck;

  setGoals: (goalReviews: number, goalNew: number) => void;
  updateSrsSettings: (patch: Partial<SrsSettings>) => void;
  updateAppSettings: (patch: Partial<AppSettings>) => void;
  markOnboarded: () => void;
  replayOnboarding: () => void;
  factoryReset: () => void;
}

interface DataValue {
  ready: boolean;
  state: DataState;
  lastCompletion: CompletionPayout | null;
  actions: DataActions;
}

const DataContext = createContext<DataValue | null>(null);

export function DataProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<DataState>(() => buildSeedState(Date.now()));
  const [ready, setReady] = useState(false);
  const [lastCompletion, setLastCompletion] = useState<CompletionPayout | null>(null);

  // Mirror for actions that need the latest committed state synchronously.
  // Updated in an effect (post-commit) — actions only fire from event
  // handlers, which always run after commit, so the mirror is never stale
  // when read.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  /* ------------------------------------------------------ load & save */

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        if (raw) {
          const parsed = JSON.parse(raw) as DataState;
          if (parsed && Array.isArray(parsed.cards) && parsed.person) {
            setState(parsed);
          }
        }
      })
      .catch(() => {
        /* corrupted store → fall back to seed */
      })
      .finally(() => setReady(true));
  }, []);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!ready) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(state)).catch(() => {});
    }, SAVE_DEBOUNCE_MS);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [state, ready]);

  /* ------------------------------------------------------------ rating */

  const rateCard = useCallback<DataActions['rateCard']>((cardId, rating, opts) => {
    const writeSchedule = opts?.writeSchedule ?? true;
    const now = Date.now();
    setState((prev) => {
      const card = prev.cards.find((c) => c.id === cardId);
      if (!card) return prev;
      const wasNew = card.reps === 0;
      const dayDone = normalizedDayDone(prev.person, now);
      const nextDayDone: DayDone = {
        ...dayDone,
        reviews: dayDone.reviews + 1,
        neww: dayDone.neww + (wasNew ? 1 : 0),
      };

      if (!writeSchedule) {
        // Cram: "Free practice — never changes your schedule."
        return { ...prev, person: { ...prev.person, dayDone: nextDayDone } };
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
          dayDone: {
            ...dayDone,
            reviews: Math.max(0, dayDone.reviews - 1),
            neww: Math.max(0, dayDone.neww - (e.wasNew ? 1 : 0)),
          },
        },
      };
    });
    return true;
  }, []);

  /* ------------------------------------------------- session completion */

  const completeSession = useCallback<DataActions['completeSession']>((args) => {
    const now = Date.now();
    const today = dayKeyOf(now);
    const prev = stateRef.current;
    const person = prev.person;

    // streak roll
    let streak = person.streak;
    let freezes = person.freezes;
    const freezeUsedDays = [...person.freezeUsedDays];
    let freezeEarned = false;
    if (person.lastStudyDay !== today) {
      const yesterday = addDays(today, -1);
      const dayBefore = addDays(today, -2);
      if (person.lastStudyDay === yesterday) {
        streak += 1;
      } else if (person.lastStudyDay === dayBefore && freezes > 0) {
        freezes -= 1;
        freezeUsedDays.push(yesterday);
        streak += 1;
      } else {
        streak = 1;
      }
    }

    const xpItems = sessionXpItems(args.counts, args.total, args.bestRun, streak);
    const xpTotal = sessionXpTotal(xpItems);
    const levelBefore = levelInfo(person.xp);
    const levelAfter = levelInfo(person.xp + xpTotal);

    const session: SessionRecord = {
      id: uid('s'),
      dayKey: today,
      atMs: now,
      kind: args.kind,
      counts: args.counts,
      total: args.total,
      bestRun: args.bestRun,
      xp: xpTotal,
    };

    // achievements (incl. freeze payouts), evaluated against the new tallies
    const masteredCount = prev.cards.filter(
      (c) => c.reps > 0 && c.stepIndex === null && c.intervalDays >= 21,
    ).length;
    const languagesStudied = new Set(prev.cards.filter((c) => c.reps > 0).map((c) => c.lang))
      .size;
    const projectedPerson: Person = {
      ...person,
      xp: person.xp + xpTotal,
      streak,
      bestStreak: Math.max(person.bestStreak, streak),
      fastAnswers: person.fastAnswers + args.fastAnswers,
    };
    const unlocked = newlyUnlocked({
      person: projectedPerson,
      cards: prev.cards,
      sessions: [...prev.sessions, session],
      masteredCount,
      languagesStudied,
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
        lastStudyDay: today,
        dayDone: normalizedDayDone(s.person, now),
        fastAnswers: s.person.fastAnswers + args.fastAnswers,
        achievements: { ...s.person.achievements, ...newAchievements },
      },
      sessions: [...s.sessions, session],
    }));
    setLastCompletion(payout);
    return payout;
  }, []);

  const clearLastCompletion = useCallback(() => setLastCompletion(null), []);

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
      word: fields.word,
      article: fields.article ?? null,
      base: fields.base ?? fields.word,
      tr: fields.tr,
      ipa: fields.ipa,
      ex: fields.ex,
      exTr: fields.exTr,
      level: fields.level ?? null,
      type: fields.type ?? null,
      lang: fields.lang ?? 'de',
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
      flag: fields.flag ?? '📚',
      lang: fields.lang ?? '',
      level: fields.level ?? null,
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
    setState((s) => {
      let cards = s.cards;
      let decks = s.decks.filter((d) => d.id !== deckId);
      if (strategy.kind === 'delete') {
        cards = cards.filter((c) => c.deckId !== deckId);
      } else if (strategy.kind === 'move') {
        cards = cards.map((c) => (c.deckId === deckId ? { ...c, deckId: strategy.targetDeckId } : c));
      } else {
        // keep: cards survive in an "Unfiled" deck created on demand
        let unfiled = decks.find((d) => d.id === 'unfiled');
        if (!unfiled) {
          unfiled = {
            id: 'unfiled',
            name: 'Unfiled cards',
            flag: '🗃️',
            lang: '',
            level: null,
            builtin: false,
            active: true,
            createdAt: Date.now(),
          };
          decks = [...decks, unfiled];
        }
        cards = cards.map((c) => (c.deckId === deckId ? { ...c, deckId: 'unfiled' } : c));
      }
      return { ...s, cards, decks };
    });
  }, []);

  const importDeck = useCallback<DataActions['importDeck']>((deckFields, cardFields) => {
    const now = Date.now();
    const deck: Deck = {
      id: uid('d'),
      name: deckFields.name,
      flag: deckFields.flag,
      lang: deckFields.lang,
      level: deckFields.level ?? null,
      builtin: false,
      active: true,
      createdAt: now,
    };
    const srs = stateRef.current.settings.srs;
    const cards: Card[] = cardFields.map((f, i) => ({
      id: uid('c'),
      deckId: deck.id,
      word: f.word,
      article: f.article ?? null,
      base: f.base ?? f.word,
      tr: f.tr,
      ipa: f.ipa,
      ex: f.ex,
      exTr: f.exTr,
      level: f.level ?? null,
      type: f.type ?? null,
      lang: f.lang ?? 'de',
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
    AsyncStorage.removeItem(STORAGE_KEY).catch(() => {});
  }, []);

  const actions = useMemo<DataActions>(
    () => ({
      rateCard,
      undoLastReview,
      completeSession,
      clearLastCompletion,
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
    () => ({ ready, state, lastCompletion, actions }),
    [ready, state, lastCompletion, actions],
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
    const languagesStudied = new Set(
      state.cards.filter((c) => c.reps > 0).map((c) => c.lang),
    ).size;
    return achievementStatuses({
      person: state.person,
      cards: state.cards,
      sessions: state.sessions,
      masteredCount,
      languagesStudied,
      fastAnswers: state.person.fastAnswers,
    });
  }, [state]);
}
