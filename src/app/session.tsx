/**
 * Study session — the sacred loop (screen-session.jsx).
 * Chrome-minimal: thin ink progress line, the card centered with the queue
 * visible as a stack beneath it. Tap to reveal, rate on the 4-button scale
 * with predicted intervals (computed live from SM-2), undo every rating
 * (A1, backed by a real review-log revert), "Again" visibly requeues at
 * idx+3, quiet streak milestones, exit-with-progress confirms and records
 * a partial session.
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  Bar,
  Btn,
  IconBtn,
  Ion,
  LevelBadge,
  ListRow,
  Pill,
  RiseIn,
  Sheet,
  SnackbarView,
} from '@/components/ui';
import { buildQueue } from '@/domain/queue';
import { speakWord } from '@/domain/speech';
import { predictAll, stepLabel } from '@/domain/srs';
import { Card, Rating, SessionKind } from '@/domain/types';
import { normalizedDayDone, useData } from '@/store/DataContext';
import { font, tnum } from '@/theme/tokens';
import { useColors } from '@/theme/ThemeContext';

interface QueueCard extends Card {
  requeued?: boolean;
}

interface Snapshot {
  queue: QueueCard[];
  idx: number;
  counts: Record<Rating, number>;
  run: number;
  /** Whether this rating wrote to the SRS schedule (cram doesn't). */
  wrote: boolean;
}

const FAST_ANSWER_MS = 3000;
const RATING_LABELS: Record<Rating, string> = {
  again: 'Again',
  hard: 'Hard',
  good: 'Good',
  easy: 'Easy',
};

function RatingBtn({
  label,
  interval,
  fg,
  tint,
  onPress,
}: {
  label: string;
  interval: string;
  fg: string;
  tint: string;
  onPress: () => void;
}) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flex: 1,
        alignItems: 'center',
        gap: 3,
        backgroundColor: tint,
        borderWidth: 1,
        borderColor: fg + '47', // ≈28% — softTint(color, 28) in the mock
        borderRadius: 14,
        paddingTop: 12,
        paddingBottom: 10,
        paddingHorizontal: 4,
        transform: [{ scale: pressed ? 0.96 : 1 }],
      })}
    >
      <Text style={[font('sans', 800), { fontSize: 14.5, color: fg }]}>{label}</Text>
      <Text style={[font('mono', 400), { fontSize: 11.5, color: c.ink3 }]}>{interval}</Text>
    </Pressable>
  );
}

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

  const startedAt = useRef(0);
  const revealedAt = useRef(0);
  const fastAnswers = useRef(0);
  useEffect(() => {
    startedAt.current = Date.now();
  }, []);

  const card = queue[idx];
  const total = queue.length;
  const reviewed = idx;

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

  const reveal = () => {
    if (revealed) return;
    setRevealed(true);
    revealedAt.current = Date.now();
  };

  const finish = (finalCounts: Record<Rating, number>, finalTotal: number, finalBest: number) => {
    actions.completeSession({
      kind,
      label,
      counts: finalCounts,
      total: finalTotal,
      bestRun: finalBest,
      durationSec: Math.round((Date.now() - startedAt.current) / 1000),
      fastAnswers: fastAnswers.current,
    });
    router.replace('/complete');
  };

  const rate = (r: Rating) => {
    if (!card || !pred) return;
    const snapshot: Snapshot = { queue, idx, counts, run, wrote: writesSchedule };
    if (Date.now() - revealedAt.current < FAST_ANSWER_MS) fastAnswers.current += 1;

    actions.rateCard(card.id, r, { writeSchedule: writesSchedule });

    const nextCounts = { ...counts, [r]: counts[r] + 1 };
    let nextQueue = queue;
    if (r === 'again') {
      // requeue this card a few positions later, same session
      nextQueue = [...queue];
      const reinsert = Math.min(idx + 3, nextQueue.length);
      nextQueue.splice(reinsert, 0, { ...card, requeued: true });
    }
    const nextRun = r === 'again' ? 0 : run + 1;
    const nextBest = Math.max(bestRun, nextRun);
    if (nextRun > 0 && nextRun % 5 === 0) setMilestone(nextRun);

    setSnack({
      text:
        r === 'again'
          ? `${card.base} is coming back soon in this session`
          : `Rated ${RATING_LABELS[r]} · next in ${pred[r]}`,
      undo: true,
    });
    setHistory([...history, snapshot]);
    setCounts(nextCounts);
    setRun(nextRun);
    setBestRun(nextBest);
    setRevealed(false);

    if (idx + 1 >= nextQueue.length) {
      finish(nextCounts, idx + 1, nextBest);
    } else {
      setQueue(nextQueue);
      setIdx(idx + 1);
    }
  };

  const undo = () => {
    if (!history.length) return;
    const prev = history[history.length - 1];
    if (prev.wrote) actions.undoLastReview();
    setHistory(history.slice(0, -1));
    setQueue(prev.queue);
    setIdx(prev.idx);
    setCounts(prev.counts);
    setRun(prev.run);
    setRevealed(true);
    setSnack({ text: 'Rating undone — card restored', undo: false });
  };

  const exitNow = () => {
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
    setSnack({ text: `${card.base} buried until tomorrow`, undo: false });
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
    return (
      <View style={{ flex: 1, backgroundColor: c.paper, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
        <Ion name="checkmark-circle" size={48} color={c.success} />
        <Text style={[font('serif', 600), { fontSize: 24, color: c.ink, marginTop: 14, textAlign: 'center' }]}>
          Nothing to study here.
        </Text>
        <Text style={[font('sans', 400), { fontSize: 14, color: c.ink2, marginTop: 6, marginBottom: 20, textAlign: 'center' }]}>
          You’re all caught up. Come back tomorrow — or study ahead.
        </Text>
        <Btn onPress={() => router.back()}>Back</Btn>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.paper }}>
      {/* ——— header ——— */}
      <View style={{ paddingTop: insets.top + 8, paddingHorizontal: 14 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <IconBtn
            icon="close"
            size={36}
            iconSize={20}
            color={c.ink2}
            onPress={() => (reviewed > 0 ? setConfirmExit(true) : router.back())}
          />
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text style={[font('mono', 400), tnum, { fontSize: 13.5, color: c.ink2 }]}>
              {idx + 1} <Text style={{ color: c.ink3 }}>/ {total}</Text>
            </Text>
          </View>
          <IconBtn
            icon="arrow-undo"
            size={36}
            iconSize={18}
            disabled={!history.length}
            onPress={undo}
            color={c.ink2}
          />
          <IconBtn
            icon="ellipsis-horizontal"
            size={36}
            iconSize={18}
            onPress={() => setMoreOpen(true)}
            color={c.ink2}
          />
        </View>
        <View style={{ marginTop: 8, marginHorizontal: 2 }}>
          <Bar value={(idx / total) * 100} h={3} />
        </View>
      </View>

      {/* ——— the card ——— */}
      <View style={{ flex: 1, justifyContent: 'center', paddingHorizontal: 22, paddingVertical: 12 }}>
        {milestone && (
          <View style={{ position: 'absolute', top: 6, left: 0, right: 0, alignItems: 'center', zIndex: 5 }}>
            <RiseIn kind="pop" duration={300}>
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 6,
                  backgroundColor: c.amberTint,
                  paddingVertical: 7,
                  paddingHorizontal: 14,
                  borderRadius: 999,
                }}
              >
                <Ion name="flame" size={15} color={c.amber} />
                <Text style={[font('sans', 800), { fontSize: 13.5, color: c.amberDeep }]}>
                  {milestone} in a row
                </Text>
              </View>
            </RiseIn>
          </View>
        )}

        <View>
          {/* queue stack beneath */}
          <View
            style={{
              position: 'absolute',
              left: 14,
              right: 14,
              bottom: -10,
              height: 30,
              backgroundColor: c.card,
              borderWidth: 1,
              borderColor: c.hairline,
              borderRadius: 18,
              opacity: 0.55,
            }}
          />
          <View
            style={{
              position: 'absolute',
              left: 7,
              right: 7,
              bottom: -5,
              height: 30,
              backgroundColor: c.card,
              borderWidth: 1,
              borderColor: c.hairline,
              borderRadius: 18,
              opacity: 0.8,
            }}
          />

          <RiseIn key={`${card.id}-${idx}`} duration={280}>
            <Pressable
              onPress={reveal}
              style={[
                {
                  backgroundColor: c.card,
                  borderWidth: 1,
                  borderColor: c.hairline,
                  borderRadius: 20,
                  minHeight: 330,
                  paddingTop: 18,
                  paddingHorizontal: 22,
                  paddingBottom: 20,
                },
                c.shadow.card,
              ]}
            >
              {/* card top row */}
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <LevelBadge level={card.level} />
                {step ? (
                  <Pill mono fg={c.amberDeep} bg={c.amberTint}>
                    step {step}
                  </Pill>
                ) : null}
                {card.requeued ? (
                  <Pill fg={c.danger} bg={c.dangerTint}>
                    again
                  </Pill>
                ) : null}
                <View style={{ flex: 1 }} />
                <IconBtn
                  icon="volume-high-outline"
                  size={34}
                  iconSize={18}
                  color={c.pine}
                  bg={c.pineTint}
                  onPress={() => speakWord(card.word, card.lang)}
                />
              </View>

              {!revealed ? (
                /* front — the word */
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                  {card.article ? (
                    <Text
                      style={[font('serif', 400, true), { fontSize: 21, color: c.amberDeep, marginBottom: 2 }]}
                    >
                      {card.article}
                    </Text>
                  ) : null}
                  <Text
                    style={[
                      font('serif', 600),
                      {
                        fontSize: 42,
                        lineHeight: 44,
                        letterSpacing: -0.63,
                        color: c.ink,
                        textAlign: 'center',
                      },
                    ]}
                  >
                    {card.base}
                  </Text>
                  {card.ipa ? (
                    <Text
                      numberOfLines={1}
                      style={[font('mono', 400), { fontSize: 14, color: c.ink3, marginTop: 10 }]}
                    >
                      {card.ipa}
                    </Text>
                  ) : null}
                  <View
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 34 }}
                  >
                    <Ion name="hand-left-outline" size={14} color={c.ink3} />
                    <Text style={[font('sans', 700), { fontSize: 12.5, color: c.ink3 }]}>
                      Tap to reveal
                    </Text>
                  </View>
                </View>
              ) : (
                /* back — the answer */
                <RiseIn duration={220} distance={0} style={{ flex: 1 }}>
                  <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                    <Text style={[font('sans', 700), { fontSize: 14.5, color: c.ink3 }]}>
                      {card.word}
                    </Text>
                    <View
                      style={{ width: 36, height: 1, backgroundColor: c.hairlineStrong, marginVertical: 13 }}
                    />
                    <Text
                      style={[
                        font('serif', 600),
                        {
                          fontSize: 31,
                          lineHeight: 35,
                          letterSpacing: -0.47,
                          color: c.ink,
                          textAlign: 'center',
                        },
                      ]}
                    >
                      {card.tr}
                    </Text>
                    {card.ex ? (
                      <Text
                        style={[
                          font('serif', 400, true),
                          {
                            fontSize: 16.5,
                            lineHeight: 24,
                            color: c.ink2,
                            textAlign: 'center',
                            marginTop: 18,
                          },
                        ]}
                      >
                        {card.ex}
                      </Text>
                    ) : null}
                    {card.exTr ? (
                      <Text
                        style={[
                          font('sans', 400),
                          { fontSize: 13, color: c.ink3, textAlign: 'center', marginTop: 4 },
                        ]}
                      >
                        {card.exTr}
                      </Text>
                    ) : null}
                    <View style={{ marginTop: 16 }}>
                      <Pill>{card.type}</Pill>
                    </View>
                  </View>
                </RiseIn>
              )}
            </Pressable>
          </RiseIn>
        </View>
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
            <View style={{ flexDirection: 'row', gap: 9 }}>
              <RatingBtn
                label="Again"
                interval={pred.again}
                fg={c.rate.again.fg}
                tint={c.rate.again.tint}
                onPress={() => rate('again')}
              />
              <RatingBtn
                label="Hard"
                interval={pred.hard}
                fg={c.rate.hard.fg}
                tint={c.rate.hard.tint}
                onPress={() => rate('hard')}
              />
              <RatingBtn
                label="Good"
                interval={pred.good}
                fg={c.rate.good.fg}
                tint={c.rate.good.tint}
                onPress={() => rate('good')}
              />
              <RatingBtn
                label="Easy"
                interval={pred.easy}
                fg={c.rate.easy.fg}
                tint={c.rate.easy.tint}
                onPress={() => rate('easy')}
              />
            </View>
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
      <Sheet open={moreOpen} onClose={() => setMoreOpen(false)} title={card.base}>
        <ListRow
          icon="repeat"
          title="Reschedule"
          sub="Set when you'll see this next · difficulty unchanged"
          onPress={() => {
            setMoreOpen(false);
            setSnack({ text: 'Reschedule — pick the next review date', undo: false });
          }}
        />
        <ListRow
          icon="eye-off-outline"
          title="Bury for now"
          sub="Skip today without changing its schedule"
          onPress={bury}
        />
        <ListRow
          icon={card.flagged ? 'flag' : 'flag-outline'}
          title={card.flagged ? 'Unflag' : 'Flag'}
          sub="Bookmark for later — no effect on scheduling"
          onPress={() => {
            setMoreOpen(false);
            actions.setCardProps([card.id], { flagged: !card.flagged });
            setSnack({ text: `${card.base} ${card.flagged ? 'unflagged' : 'flagged'}`, undo: false });
          }}
        />
        <ListRow
          icon="swap-horizontal"
          title="Switch mode"
          sub="Flashcard · typing · multiple choice"
          onPress={() => {
            setMoreOpen(false);
            setSnack({ text: 'Mode switch — flashcard · typing · quiz', undo: false });
          }}
          last
        />
      </Sheet>

      {/* exit confirm */}
      <Sheet open={confirmExit} onClose={() => setConfirmExit(false)} title="End this session?">
        <Text
          style={[font('sans', 400), { fontSize: 14.5, lineHeight: 22, color: c.ink2, marginBottom: 18 }]}
        >
          The {reviewed} {reviewed === 1 ? 'card' : 'cards'} you reviewed will be saved.
        </Text>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Btn kind="secondary" full style={{ flex: 1 }} onPress={() => setConfirmExit(false)}>
            Keep studying
          </Btn>
          <Btn
            full
            style={{ flex: 1 }}
            onPress={() => {
              setConfirmExit(false);
              exitNow();
            }}
          >
            End session
          </Btn>
        </View>
      </Sheet>
    </View>
  );
}
