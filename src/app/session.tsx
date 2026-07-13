/**
 * Study session — the sacred loop (screen-session.jsx).
 * Chrome-minimal: thin ink progress line, the card centered with the queue
 * visible as a stack beneath it. Tap to reveal, rate on the 4-button scale
 * with predicted intervals (computed live from SM-2), undo every rating
 * (A1, backed by a real review-log revert), "Again" visibly requeues at
 * idx+3, quiet streak milestones, exit-with-progress confirms and records
 * a partial session.
 */
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CardActionsSheet } from '@/components/study/CardActionsSheet';
import { EmptyQueue } from '@/components/study/EmptyQueue';
import { ExitConfirmSheet } from '@/components/study/ExitConfirmSheet';
import { MilestoneToast } from '@/components/study/MilestoneToast';
import { RatingButtons } from '@/components/study/RatingButtons';
import { SessionHeader } from '@/components/study/SessionHeader';
import { StudyCard } from '@/components/study/StudyCard';
import { Ion, RiseIn, SnackbarView } from '@/components/ui';
import { buildQueue } from '@/domain/queue';
import { speak } from '@/domain/speech';
import { applyRating, predictAll, stepLabel } from '@/domain/srs';
import { Card, dayKeyOf, Rating, SessionKind } from '@/domain/types';
import { normalizedDayDone, useData } from '@/store/DataContext';
import { font } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

interface QueueCard extends Card {
  requeued?: boolean;
}

interface Snapshot {
  queue: QueueCard[];
  idx: number;
  counts: Record<Rating, number>;
  run: number;
  /** bestRun BEFORE this rating, so undo can revert the run-bonus mirror too —
   *  otherwise an undone run still pays its XP and misrecords the session (L9's
   *  sibling: L9 restored fastAnswers but not bestRun). */
  bestRun: number;
  /** Whether this rating wrote to the SRS schedule (cram doesn't). */
  wrote: boolean;
  /** fastAnswers tally BEFORE this rating, so undo can revert it (L9). */
  fastAnswers: number;
}

const FAST_ANSWER_MS = 3000;
const RATING_LABELS: Record<Rating, string> = {
  again: 'Again',
  hard: 'Hard',
  good: 'Good',
  easy: 'Easy',
};

export default function SessionScreen() {
  const c = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { state, actions } = useData();
  const params = useLocalSearchParams<{
    kind?: string;
    deckId?: string;
    collectionId?: string;
    cardIds?: string;
    label?: string;
  }>();

  const kind = (params.kind ?? 'scheduled') as SessionKind;
  const label =
    params.label ?? state.decks.find((d) => d.id === params.deckId)?.name ?? 'All decks';
  const writesSchedule = kind !== 'cram';

  // Build the queue ONCE from the live store, then own it locally.
  const [queue, setQueue] = useState<QueueCard[]>(() => {
    const now = Date.now();
    // explicit selection ("Study these" from the library bulk bar)
    if (params.cardIds) {
      const ids = params.cardIds.split(',');
      const byId = new Map(state.cards.map((card) => [card.id, card]));
      return ids
        .map((id) => byId.get(id))
        .filter((card): card is Card => !!card && !card.suspended);
    }
    const activeIds = new Set(state.decks.filter((d) => d.active).map((d) => d.id));
    const pool = params.deckId
      ? state.cards
      : state.cards.filter((card) => activeIds.has(card.deckId));
    return buildQueue(pool, {
      kind,
      deckId: params.deckId || undefined,
      collection: state.collections.find((col) => col.id === params.collectionId),
      now,
      settings: state.settings.srs,
      done: normalizedDayDone(state.person, now),
      // ahead/cram/hardest honour the user's session size, not a hardcoded 20 (M7).
      cap: state.settings.sessionLimit,
    });
  });
  const [idx, setIdx] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [history, setHistory] = useState<Snapshot[]>([]);
  const [counts, setCounts] = useState<Record<Rating, number>>({
    again: 0,
    hard: 0,
    good: 0,
    easy: 0,
  });
  const [run, setRun] = useState(0);
  const [bestRun, setBestRun] = useState(0);
  const [milestone, setMilestone] = useState<number | null>(null);
  const [snack, setSnack] = useState<{ text: string; undo: boolean } | null>(null);
  const [confirmExit, setConfirmExit] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  const navigation = useNavigation();
  const startedAt = useRef(0);
  const revealedAt = useRef(0);
  const fastAnswers = useRef(0);
  const ratingLock = useRef(false); // re-entrancy guard against double-taps
  const committedRef = useRef(false); // true once this session has been finalized
  useEffect(() => {
    startedAt.current = Date.now();
  }, []);

  // Release the re-entrancy lock whenever a new card is presented.
  useEffect(() => {
    ratingLock.current = false;
  }, [idx]);

  const card = queue[idx];
  const total = queue.length;
  const reviewed = idx;

  // The day the session's reviews belong to (its start day), threaded into every
  // completion + the in-flight marker so the streak/freeze roll and SessionRecord
  // land on the day the user studied — not completeSession's own clock, which is a
  // different day for a session finishing after local midnight or one banked by
  // the boot reconciler on a later day (#2/#3).
  const sessionDay = () => dayKeyOf(startedAt.current || Date.now());

  const pred = useMemo(
    () => (card ? predictAll(card, state.settings.srs) : null),
    [card, state.settings.srs],
  );
  const step = card ? stepLabel(card, state.settings.srs) : null;

  useEffect(() => {
    if (!snack) return;
    const t = setTimeout(() => setSnack(null), 2600);
    return () => clearTimeout(t);
  }, [snack]);

  useEffect(() => {
    if (!milestone) return;
    const t = setTimeout(() => setMilestone(null), 1600);
    return () => clearTimeout(t);
  }, [milestone]);

  // Finalize a partial session on ANY exit the explicit close doesn't cover —
  // Android hardware-back, the iOS edge-swipe. Per-rating schedule writes are
  // already committed; this saves the XP/streak/record for what was reviewed so
  // leaving mid-session doesn't silently drop them. committedRef stops a double
  // commit when finish()/exitNow() already finalized (M5).
  useEffect(() => {
    const unsub = navigation.addListener('beforeRemove', () => {
      if (committedRef.current || reviewed === 0) return;
      committedRef.current = true;
      actions.completeSession({
        kind,
        label,
        counts,
        total: reviewed,
        bestRun,
        durationSec: Math.round((Date.now() - startedAt.current) / 1000),
        fastAnswers: fastAnswers.current,
        studyDay: sessionDay(),
      });
      actions.clearLastCompletion();
    });
    return unsub;
  }, [navigation, reviewed, counts, bestRun, kind, label, actions]);

  const reveal = () => {
    if (revealed) return;
    setRevealed(true);
    revealedAt.current = Date.now();
  };

  const finish = (
    finalCounts: Record<Rating, number>,
    finalTotal: number,
    finalBest: number,
    finalCard?: Card,
  ) => {
    committedRef.current = true; // this session is finalized — block the partial-commit on removal
    actions.completeSession({
      kind,
      label,
      counts: finalCounts,
      total: finalTotal,
      bestRun: finalBest,
      durationSec: Math.round((Date.now() - startedAt.current) / 1000),
      fastAnswers: fastAnswers.current,
      studyDay: sessionDay(),
      finalCard,
    });
    router.replace('/complete');
  };

  const rate = (r: Rating) => {
    if (!card || !pred) return;
    if (ratingLock.current) return; // ignore a second tap before the next card mounts
    ratingLock.current = true;
    const snapshot: Snapshot = {
      queue,
      idx,
      counts,
      run,
      bestRun,
      wrote: writesSchedule,
      fastAnswers: fastAnswers.current,
    };
    if (Date.now() - revealedAt.current < FAST_ANSWER_MS) fastAnswers.current += 1;

    actions.rateCard(card.id, r, { writeSchedule: writesSchedule });

    const nextCounts = { ...counts, [r]: counts[r] + 1 };
    let nextQueue = queue;
    if (r === 'again') {
      // requeue this card a few positions later, same session — re-entering with
      // the POST-Again state so its predicted intervals reflect the lapse, not
      // the pre-rating card (M10).
      nextQueue = [...queue];
      const reinsert = Math.min(idx + 3, nextQueue.length);
      const reentered = applyRating(card, 'again', state.settings.srs, Date.now());
      nextQueue.splice(reinsert, 0, { ...reentered, requeued: true });
    }
    const nextRun = r === 'again' ? 0 : run + 1;
    const nextBest = Math.max(bestRun, nextRun);
    if (nextRun > 0 && nextRun % 5 === 0) setMilestone(nextRun);

    setSnack({
      text:
        r === 'again'
          ? `${card.front} is coming back soon in this session`
          : `Rated ${RATING_LABELS[r]} · next in ${pred[r]}`,
      undo: true,
    });
    setHistory([...history, snapshot]);
    setCounts(nextCounts);
    setRun(nextRun);
    setBestRun(nextBest);
    setRevealed(false);

    if (idx + 1 >= nextQueue.length) {
      // Pass the freshly-rated card so end-of-session mastery achievements score
      // against true final state (cram doesn't reschedule).
      const finalCard = writesSchedule
        ? applyRating(card, r, state.settings.srs, Date.now())
        : undefined;
      finish(nextCounts, idx + 1, nextBest, finalCard);
    } else {
      // Persist progress-so-far so an app-kill mid-session doesn't drop its
      // XP/streak/record (the schedule already persists per rating). Reconciled
      // on next boot; cleared by completeSession on any clean exit (M5).
      actions.trackSession({
        kind,
        label,
        counts: nextCounts,
        total: idx + 1,
        bestRun: nextBest,
        durationSec: Math.round((Date.now() - startedAt.current) / 1000),
        fastAnswers: fastAnswers.current,
        studyDay: sessionDay(),
      });
      setQueue(nextQueue);
      setIdx(idx + 1);
    }
  };

  const undo = () => {
    if (!history.length) return;
    const prev = history[history.length - 1];
    if (prev.wrote) actions.undoLastReview();
    setHistory(history.slice(0, -1));
    // Reconcile the restored queue against the store: a bury (or suspend) commits
    // to the store but pushes no history entry, so a naive restore of prev.queue
    // would resurrect a buried card into the session while its buriedUntil stays
    // set everywhere else. Drop such cards, but keep the already-reviewed prefix
    // (≤ prev.idx) so the index still points at the card being un-rated (#6).
    const now = Date.now();
    const blocked = new Set(
      state.cards
        .filter((cd) => cd.suspended || (cd.buriedUntil != null && cd.buriedUntil > now))
        .map((cd) => cd.id),
    );
    setQueue(prev.queue.filter((q, i) => i <= prev.idx || !blocked.has(q.id)));
    setIdx(prev.idx);
    setCounts(prev.counts);
    setRun(prev.run);
    setBestRun(prev.bestRun); // revert the run-bonus mirror too (#7)
    fastAnswers.current = prev.fastAnswers; // revert the fast-answer tally too (L9)
    // Keep the persisted crash-recovery marker in step with the revert, so the
    // boot reconciler can't bank undone reviews: clear it when the undo returns
    // to zero reviews, else mirror the reverted counts/total (#4).
    if (prev.idx === 0) {
      actions.trackSession(null);
    } else {
      actions.trackSession({
        kind,
        label,
        counts: prev.counts,
        total: prev.idx,
        bestRun: prev.bestRun,
        durationSec: Math.round((Date.now() - startedAt.current) / 1000),
        fastAnswers: prev.fastAnswers,
        studyDay: sessionDay(),
      });
    }
    setRevealed(true);
    setSnack({ text: 'Rating undone — card restored', undo: false });
  };

  const exitNow = () => {
    committedRef.current = true; // finalized here — block the beforeRemove partial commit
    if (reviewed > 0) {
      // partial sessions still count (the exit copy promises it)
      actions.completeSession({
        kind,
        label,
        counts,
        total: reviewed,
        bestRun,
        durationSec: Math.round((Date.now() - startedAt.current) / 1000),
        fastAnswers: fastAnswers.current,
        studyDay: sessionDay(),
      });
      actions.clearLastCompletion();
    }
    router.back();
  };

  const bury = () => {
    if (!card) return;
    setMoreOpen(false);
    actions.buryCard(card.id);
    const nextQueue = queue.filter((q, i) => !(i >= idx && q.id === card.id));
    setSnack({ text: `${card.front} buried until tomorrow`, undo: false });
    if (idx >= nextQueue.length) {
      if (reviewed > 0) finish(counts, reviewed, bestRun);
      else router.back();
    } else {
      setQueue(nextQueue);
      setRevealed(false);
    }
  };

  /* ——— empty queue: nothing to study ——— */
  if (!card) {
    return <EmptyQueue onBack={() => router.back()} />;
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.paper }}>
      {/* ——— header ——— */}
      <SessionHeader
        idx={idx}
        total={total}
        canUndo={history.length > 0}
        onClose={() => (reviewed > 0 ? setConfirmExit(true) : router.back())}
        onUndo={undo}
        onMore={() => setMoreOpen(true)}
      />

      {/* ——— the card ——— */}
      <View style={{ flex: 1, justifyContent: 'center', paddingHorizontal: 22, paddingVertical: 12 }}>
        {milestone && <MilestoneToast n={milestone} />}
        <StudyCard
          key={`${card.id}-${idx}`}
          card={card}
          revealed={revealed}
          step={step}
          requeued={card.requeued}
          canSpeak={state.settings.readAloudEnabled}
          onReveal={reveal}
          onSpeak={() => speak(revealed ? card.back : card.front)}
        />
      </View>

      {/* ——— rating zone (stable height) ——— */}
      <View
        style={{
          paddingHorizontal: 18,
          paddingBottom: insets.bottom + 26,
          minHeight: 96 + insets.bottom,
        }}
      >
        {revealed && pred ? (
          <RiseIn duration={200}>
            <RatingButtons pred={pred} onRate={rate} />
          </RiseIn>
        ) : (
          <View
            style={{
              height: 62,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 14,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              <Ion name="bulb-outline" size={15} color={c.ink3} />
              <Text style={[font('sans', 400), { fontSize: 13, color: c.ink3 }]}>Hint</Text>
            </View>
            <Text style={[font('sans', 400), { fontSize: 13, color: c.ink3, opacity: 0.4 }]}>·</Text>
            <Text style={[font('sans', 400), { fontSize: 13, color: c.ink3 }]}>
              tap the card to reveal
            </Text>
          </View>
        )}
      </View>

      {snack && (
        <SnackbarView
          text={snack.text}
          onAction={snack.undo ? undo : undefined}
          bottom={insets.bottom + 96}
        />
      )}

      {/* per-card actions */}
      <CardActionsSheet
        card={card}
        open={moreOpen}
        onClose={() => setMoreOpen(false)}
        onBury={bury}
        onFlag={() => {
          setMoreOpen(false);
          actions.setCardProps([card.id], { flagged: !card.flagged });
          setSnack({ text: `${card.front} ${card.flagged ? 'unflagged' : 'flagged'}`, undo: false });
        }}
        onSnack={(text) => setSnack({ text, undo: false })}
      />

      {/* exit confirm */}
      <ExitConfirmSheet
        open={confirmExit}
        reviewed={reviewed}
        onKeep={() => setConfirmExit(false)}
        onEnd={() => {
          setConfirmExit(false);
          exitNow();
        }}
      />
    </View>
  );
}
